const IMAGE_URL_RE = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i;
const MIN_IMAGE_SIZE = 96;
const THUMBNAIL_MAX_DIMENSION = 512;
const MIN_ORIGINAL_DIMENSION = 768;
const MIN_ORIGINAL_BLOB_SIZE_BYTES = 700 * 1024;
const DEFAULT_DETAIL_OPEN_TIMEOUT_MS = 5000;
const DETAIL_DOWNLOAD_OPEN_TIMEOUT_MS = 8000;
const DETAIL_SETTLE_MS = 700;
const CLOSE_SETTLE_MS = 300;
const ESTUARY_CONTENT_PATHS = new Set([
  "/api/estuary/content",
  "/backend-api/estuary/content"
]);
const URL_CANDIDATE_ATTRS = [
  "href",
  "src",
  "poster",
  "content",
  "data-src",
  "data-url",
  "data-original",
  "data-original-src",
  "data-full-src",
  "data-download-url"
];
const DIRECT_RESOURCE_CANDIDATE_LIMIT = 600;
const PREPARED_IMAGE_OBJECT_URL_TTL_MS = 5 * 60 * 1000;
const IMAGE_MIME_EXTENSIONS = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/x-png": "png"
};
const activeScanJobs = new Set();
const preparedImageDownloads = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "PING_CHATGPT_IMAGE_CONTENT") {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "PREPARE_IMAGE_DOWNLOAD") {
    prepareImageDownload(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message.type === "GET_PREPARED_IMAGE_DATA_URL") {
    getPreparedImageDataUrl(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message.type === "REVOKE_PREPARED_IMAGE_DOWNLOAD") {
    revokePreparedImageDownload(message.payload?.downloadUrl);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "CANCEL_CHATGPT_IMAGE_JOB") {
    if (message.payload?.jobId) {
      activeScanJobs.delete(message.payload.jobId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "SCAN_CHATGPT_IMAGES") {
    scanChatGptImages(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  return false;
});

async function scanChatGptImages(options = {}) {
  const jobId = options.jobId || `${Date.now()}`;
  const maxScrolls = clamp(numberOrDefault(options.maxScrolls, 30), 0, 250);
  const scrollDelayMs = clamp(numberOrDefault(options.scrollDelayMs, 900), 100, 5000);
  const detailOpenTimeoutMs = clamp(numberOrDefault(options.detailOpenTimeoutMs, DEFAULT_DETAIL_OPEN_TIMEOUT_MS), 800, 8000);
  const cards = new Map();
  const originals = new Map();
  const collectionStats = createCollectionStats();
  let detailFailureCount = 0;
  let unchangedScrolls = 0;

  activeScanJobs.add(jobId);
  reportLog(jobId, "info", "内容脚本开始扫描", {
    maxScrolls,
    scrollDelayMs,
    detailOpenTimeoutMs
  }, "scan");
  collectImageCards(cards, collectionStats);
  reportProgress(jobId, {
    stage: "collecting",
    message: `已收集 ${cards.size} 张缩略图，正在继续滚动...`,
    scanned: cards.size,
    total: cards.size
  });

  for (let i = 0; i < maxScrolls; i += 1) {
    ensureJobActive(jobId);
    const beforeCount = cards.size;
    const beforeY = window.scrollY;

    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "smooth"
    });

    await sleep(scrollDelayMs);
    collectImageCards(cards, collectionStats);
    reportProgress(jobId, {
      stage: "collecting",
      message: `已收集 ${cards.size} 张缩略图，滚动进度 ${i + 1}/${maxScrolls}...`,
      scanned: cards.size,
      total: cards.size
    });

    const afterY = window.scrollY;
    if (cards.size === beforeCount && Math.abs(afterY - beforeY) < 20) {
      unchangedScrolls += 1;
    } else {
      unchangedScrolls = 0;
    }

    if (unchangedScrolls >= 3) {
      break;
    }
  }

  const cardList = Array.from(cards.values()).filter((card) => document.contains(card.element));
  reportLog(jobId, "info", "缩略图收集完成", {
    collected: cardList.length,
    checked: collectionStats.checked,
    skippedSmall: collectionStats.skippedSmall,
    skippedNoCandidate: collectionStats.skippedNoCandidate,
    skippedUiAsset: collectionStats.skippedUiAsset,
    skippedSamples: collectionStats.skippedSamples
  }, "scan");

  if (!cardList.length && collectionStats.skippedUiAsset) {
    reportLog(jobId, "warn", "只发现 ChatGPT 页面素材，未发现可下载的生成图", {
      hint: "请确认当前标签页已登录，并停留在包含生成图缩略图的 Images 图库或会话页面。",
      skippedUiAsset: collectionStats.skippedUiAsset,
      skippedSamples: collectionStats.skippedSamples
    }, "scan");
  }

  reportProgress(jobId, {
    stage: "resolving",
    message: `缩略图收集完成，共 ${cardList.length} 张，开始解析原图...`,
    scanned: cardList.length,
    total: cardList.length
  });

  for (const [index, card] of cardList.entries()) {
    ensureJobActive(jobId);
    const original = await resolveOriginalFromCard(card, detailOpenTimeoutMs, jobId, index + 1);

    if (original) {
      addCandidate(originals, original);
    } else {
      detailFailureCount += 1;
      reportLog(jobId, "warn", "原图解析失败：没有返回可下载候选", {
        index: index + 1,
        total: cardList.length,
        thumbnail: summarizeUrl(card.thumbnailUrl),
        hasDerivedOriginalUrl: Boolean(card.derivedOriginalUrl)
      });
    }

    reportProgress(jobId, {
      stage: "resolving",
      message: `已扫描 ${cardList.length} 张，已解析原图 ${originals.size} 张，失败 ${detailFailureCount} 张，正在处理第 ${index + 1}/${cardList.length} 张。`,
      scanned: cardList.length,
      matched: originals.size,
      detailFailureCount,
      current: index + 1,
      total: cardList.length
    });
  }

  const directOriginals = collectDirectOriginalCandidates(cards);
  for (const directOriginal of directOriginals) {
    addCandidate(originals, directOriginal);
  }

  if (directOriginals.length) {
    reportLog(jobId, "info", "已从页面资源中直接发现可下载候选", {
      count: directOriginals.length,
      samples: directOriginals.slice(0, 5).map((image) => summarizeUrl(image.url))
    });
  }

  const images = Array.from(originals.values());
  const scannedCount = Math.max(cardList.length, images.length);
  activeScanJobs.delete(jobId);
  reportLog(jobId, images.length ? "info" : "warn", "内容脚本扫描结束", {
    scanned: scannedCount,
    visibleCards: cardList.length,
    matched: images.length,
    detailFailureCount
  }, "scan");

  return {
    scanned: scannedCount,
    matched: images.length,
    images,
    detailFailureCount,
    unknownDateCount: images.filter((image) => !image.date).length
  };
}

function collectImageCards(cards, stats = null) {
  for (const img of document.images) {
    const card = imageCardFromElement(img, stats);
    if (!card) {
      continue;
    }

    const key = canonicalUrl(card.thumbnailUrl);
    const existing = cards.get(key);
    if (!existing) {
      cards.set(key, card);
      continue;
    }

    if (!existing.resolved && document.contains(card.element)) {
      existing.element = card.element;
    }

    if ((card.width * card.height) > (existing.width * existing.height)) {
      existing.width = card.width;
      existing.height = card.height;
    }

    if (!existing.prompt && card.prompt) {
      existing.prompt = card.prompt;
    }

    if (!existing.date && card.date) {
      existing.date = card.date;
    }
  }
}

function createCollectionStats() {
  return {
    checked: 0,
    skippedSmall: 0,
    skippedNoCandidate: 0,
    skippedUiAsset: 0,
    skippedSamples: []
  };
}

function noteSkippedImage(stats, reason, url) {
  if (!stats) {
    return;
  }

  if (reason === "ui-asset") {
    stats.skippedUiAsset += 1;
  }

  if (stats.skippedSamples.length >= 8) {
    return;
  }

  stats.skippedSamples.push({
    reason,
    url: summarizeUrl(url)
  });
}

function imageCardFromElement(img, stats = null) {
  if (stats) {
    stats.checked += 1;
  }

  const rect = img.getBoundingClientRect();
  const width = Math.max(img.naturalWidth || 0, rect.width || 0);
  const height = Math.max(img.naturalHeight || 0, rect.height || 0);

  if (width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE) {
    if (stats) {
      stats.skippedSmall += 1;
    }
    return null;
  }

  const candidates = imageUrlCandidatesFromElement(img, "thumbnail");
  const thumbnail = chooseBestCandidate(candidates, "");
  if (!thumbnail) {
    const uiAssetCandidate = candidates
      .map((candidate) => toAbsoluteUrl(candidate.url))
      .find((url) => url && isUiAssetUrl(url));

    if (uiAssetCandidate) {
      noteSkippedImage(stats, "ui-asset", uiAssetCandidate);
      return null;
    }

    if (stats) {
      stats.skippedNoCandidate += 1;
    }
    return null;
  }

  if (isUiAssetUrl(thumbnail.url)) {
    noteSkippedImage(stats, "ui-asset", thumbnail.url);
    return null;
  }

  const context = nearestUsefulContext(img);
  const clickTarget = findClickableTarget(img);

  return {
    element: clickTarget,
    imageElement: img,
    context,
    thumbnailUrl: thumbnail.url,
    derivedOriginalUrl: deriveOriginalUrlFromThumbnail(thumbnail.url),
    date: findDate(img, context),
    prompt: findPrompt(img, context),
    alt: img.getAttribute("alt") || img.getAttribute("aria-label") || "",
    width: Math.round(width),
    height: Math.round(height),
    resolved: false
  };
}

async function resolveOriginalFromCard(card, detailOpenTimeoutMs, jobId, index) {
  const derivedOriginal = await originalFromDerivedThumbnail(card, jobId, index);
  if (derivedOriginal) {
    return derivedOriginal;
  }

  const beforeHref = location.href;
  const beforeUrls = currentImageUrlSet();

  const openResult = await openDetailForCard(card, {
    beforeUrls,
    beforeHref,
    timeoutMs: detailOpenTimeoutMs,
    jobId,
    index,
    stage: "resolve"
  });
  const detailRoot = openResult.root;
  if (!detailRoot) {
    reportLog(jobId, "warn", "详情未打开或未识别", {
      index,
      timeoutMs: detailOpenTimeoutMs,
      thumbnail: summarizeUrl(card.thumbnailUrl),
      clickableTag: card.element?.tagName || "",
      openAttempts: openResult.attempts
    });
    await closeDetail(beforeHref);
    return fallbackOriginalFromCard(card, jobId, index, "detail-not-opened");
  }

  await sleep(DETAIL_SETTLE_MS);

  const candidates = collectImageUrlCandidates(detailRoot);
  const best = chooseBestCandidate(candidates, card.thumbnailUrl);

  await closeDetail(beforeHref);

  if (!best) {
    reportLog(jobId, "warn", "详情打开成功，但没有找到可用图片候选", {
      index,
      candidateCount: candidates.length,
      thumbnail: summarizeUrl(card.thumbnailUrl)
    });
    return fallbackOriginalFromCard(card, jobId, index, "detail-no-candidate");
  }

  if (isSameSmallThumbnail(best, card)) {
    reportLog(jobId, "warn", "详情中只找到缩略图，已跳过", {
      index,
      candidateCount: candidates.length,
      thumbnail: summarizeUrl(card.thumbnailUrl),
      best: summarizeUrl(best.url),
      bestWidth: best.width || 0,
      bestHeight: best.height || 0
    });
    return fallbackOriginalFromCard(card, jobId, index, "detail-only-thumbnail");
  }

  reportLog(jobId, "info", "详情解析成功", {
    index,
    candidateCount: candidates.length,
    selected: summarizeUrl(best.url),
    width: Math.round(best.width || card.width || 0),
    height: Math.round(best.height || card.height || 0)
  });

  return {
    url: best.url,
    date: card.date || findDate(detailRoot, detailRoot),
    prompt: card.prompt || findPrompt(detailRoot, detailRoot),
    alt: card.alt || detailRoot.getAttribute?.("aria-label") || "",
    width: Math.round(best.width || card.width || 0),
    height: Math.round(best.height || card.height || 0)
  };
}

async function originalFromDerivedThumbnail(card, jobId, index) {
  if (!card.derivedOriginalUrl) {
    return null;
  }

  const candidate = imageResultFromCandidate({
    url: card.derivedOriginalUrl,
    width: card.width,
    height: card.height,
    source: "derived-thumbnail"
  }, card);

  const check = await checkImageReachability(candidate.url);
  if (check.ok) {
    reportLog(jobId, "info", "缩略图 URL 已成功派生原图候选", {
      index,
      original: summarizeUrl(candidate.url),
      check
    });
    return candidate;
  }

  if (shouldKeepCandidateAfterPrecheck(candidate.url, check)) {
    reportLog(jobId, "warn", "derived-original-precheck-403: opening detail view before trusting candidate", {
      index,
      original: summarizeUrl(candidate.url),
      check
    });
    return null;
    /*
    reportLog(jobId, "warn", "预检 403，保留候选继续下载", {
      index,
      original: summarizeUrl(candidate.url),
      check
    });
    return candidate;
    */
  }

  reportLog(jobId, "warn", "缩略图 URL 可派生，但预检不可用", {
    index,
    original: summarizeUrl(candidate.url),
    check
  });

  return null;
}

function fallbackOriginalFromCard(card, jobId, index, reason) {
  const candidates = collectFallbackImageUrlCandidates(card);
  const best = chooseBestCandidate(candidates, card.thumbnailUrl);

  if (!best) {
    reportLog(jobId, "warn", "Fallback 解析失败：确实没有可用 URL", {
      index,
      reason,
      candidateCount: candidates.length,
      thumbnail: summarizeUrl(card.thumbnailUrl)
    });
    return null;
  }

  if (isSameSmallThumbnail(best, card)) {
    reportLog(jobId, "warn", "Fallback 解析只找到不可用缩略图", {
      index,
      reason,
      candidateCount: candidates.length,
      thumbnail: summarizeUrl(card.thumbnailUrl),
      best: summarizeUrl(best.url)
    });
    return null;
  }

  reportLog(jobId, "info", "Fallback 解析成功，保留候选继续下载", {
    index,
    reason,
    candidateCount: candidates.length,
    selected: summarizeUrl(best.url),
    source: best.source || ""
  });

  if (isUnverifiedEstuaryFallbackCandidate(best, reason)) {
    reportLog(jobId, "warn", "Fallback rejected: candidate is only a thumbnail-derived estuary URL and was not verified in detail view", {
      index,
      reason,
      candidateCount: candidates.length,
      selected: summarizeUrl(best.url),
      source: best.source || ""
    });
    return null;
  }

  return imageResultFromCandidate(best, card);
}

function collectFallbackImageUrlCandidates(card) {
  const candidates = [];
  const derived = deriveOriginalUrlFromThumbnail(card.thumbnailUrl);

  if (card.derivedOriginalUrl) {
    candidates.push({
      url: card.derivedOriginalUrl,
      width: card.width,
      height: card.height,
      source: "fallback-derived",
      score: 900000
    });
  }

  if (derived && derived !== card.derivedOriginalUrl) {
    candidates.push({
      url: derived,
      width: card.width,
      height: card.height,
      source: "fallback-derived-live",
      score: 850000
    });
  }

  if (isRetainableDownloadCandidateUrl(card.thumbnailUrl) || isStrongImageUrl(card.thumbnailUrl)) {
    const thumbnailOriginalUrl = normalizeOriginalDownloadUrl(card.thumbnailUrl);
    candidates.push({
      url: thumbnailOriginalUrl || card.thumbnailUrl,
      width: card.width,
      height: card.height,
      source: thumbnailOriginalUrl && canonicalUrl(thumbnailOriginalUrl) !== canonicalUrl(card.thumbnailUrl)
        ? "fallback-thumbnail-originalized"
        : "fallback-thumbnail",
      score: thumbnailOriginalUrl && canonicalUrl(thumbnailOriginalUrl) !== canonicalUrl(card.thumbnailUrl)
        ? 900000
        : 650000
    });
  }

  if (card.imageElement) {
    candidates.push(...imageUrlCandidatesFromElement(card.imageElement, "fallback-img"));
  }

  const localRoots = uniqueElements([
    card.imageElement,
    card.element,
    card.imageElement?.parentElement,
    card.element?.parentElement,
    card.context
  ]);

  for (const root of localRoots) {
    candidates.push(...urlCandidatesFromElementAttributes(root, "fallback-attr", card));
    candidates.push(...linkCandidatesFromRoot(root, card));
    candidates.push(...urlCandidatesFromVisibleText(root, card));
  }

  return candidates;
}

function isUnverifiedEstuaryFallbackCandidate(candidate, reason) {
  const source = String(candidate?.source || "");
  return isEstuaryContentUrl(candidate?.url)
    && /fallback-(?:derived|thumbnail)/.test(source)
    && /detail-not-opened|detail-only-thumbnail|detail-no-candidate/.test(String(reason || ""));
}

function collectDirectOriginalCandidates(cards) {
  const rawCandidates = [];
  const cardList = Array.from(cards.values());

  for (const img of document.images) {
    const relatedCard = cardList.find((card) => card.imageElement === img) || null;
    for (const candidate of imageUrlCandidatesFromElement(img, "direct-img")) {
      addDirectOriginalCandidate(rawCandidates, candidate.url, candidate.source, {
        card: relatedCard,
        width: candidate.width,
        height: candidate.height,
        score: candidate.score
      });
    }
  }

  for (const source of document.querySelectorAll("source[srcset]")) {
    const rect = source.parentElement?.getBoundingClientRect?.();
    const candidates = srcSetCandidates(source.getAttribute("srcset"), {
      width: rect?.width || 0,
      height: rect?.height || 0,
      source: "direct-source"
    });

    for (const candidate of candidates) {
      addDirectOriginalCandidate(rawCandidates, candidate.url, candidate.source, {
        width: candidate.width,
        height: candidate.height,
        score: candidate.score
      });
    }
  }

  for (const link of document.querySelectorAll("a[href]")) {
    addDirectOriginalCandidate(rawCandidates, link.href || link.getAttribute("href"), "direct-link", {
      score: link.hasAttribute("download") ? 850000 : 350000
    });
  }

  for (const element of Array.from(document.querySelectorAll("[style]")).slice(0, 1200)) {
    const style = element.getAttribute("style") || "";
    const rect = element.getBoundingClientRect();

    for (const match of style.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
      addDirectOriginalCandidate(rawCandidates, match[1], "direct-style", {
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0),
        score: Math.round((rect.width || 0) * (rect.height || 0))
      });
    }
  }

  try {
    const entries = performance.getEntriesByType("resource")
      .slice(-DIRECT_RESOURCE_CANDIDATE_LIMIT);

    for (const entry of entries) {
      addDirectOriginalCandidate(rawCandidates, entry.name, "direct-resource", {
        score: 250000
      });
    }
  } catch {
    // Resource timing is a useful bonus signal, but not required.
  }

  return directResultsFromCandidates(rawCandidates, cardList);
}

function addDirectOriginalCandidate(candidates, rawUrl, source, options = {}) {
  const absoluteUrl = toAbsoluteUrl(rawUrl);
  if (!absoluteUrl) {
    return;
  }

  const url = normalizeOriginalDownloadUrl(absoluteUrl);
  const derived = Boolean(url && canonicalUrl(url) !== canonicalUrl(absoluteUrl));
  if (derived && hasThumbnailMarkerInUrl(absoluteUrl)) {
    return;
  }
  if (!isDirectDownloadCandidateUrl(url)) {
    return;
  }

  candidates.push({
    url,
    width: options.width || 0,
    height: options.height || 0,
    source,
    score: (options.score || 0) + (derived ? 900000 : 0),
    card: options.card || null
  });
}

function directResultsFromCandidates(candidates, cards) {
  const unique = new Map();

  for (const candidate of candidates) {
    const key = canonicalUrl(candidate.url);
    const existing = unique.get(key);
    if (!existing || directCandidateScore(candidate) > directCandidateScore(existing)) {
      unique.set(key, candidate);
    }
  }

  return Array.from(unique.values())
    .sort((a, b) => directCandidateScore(b) - directCandidateScore(a))
    .map((candidate) => {
      const card = candidate.card || findRelatedCardForCandidate(candidate.url, cards) || {
        date: null,
        prompt: "",
        alt: "",
        width: candidate.width || 0,
        height: candidate.height || 0
      };

      return imageResultFromCandidate(candidate, card);
    });
}

function directCandidateScore(candidate) {
  return Number(candidate.score || 0)
    + Math.round((candidate.width || 0) * (candidate.height || 0));
}

function findRelatedCardForCandidate(url, cards) {
  const key = canonicalUrl(url);

  return cards.find((card) => {
    return key === canonicalUrl(card.thumbnailUrl)
      || (card.derivedOriginalUrl && key === canonicalUrl(card.derivedOriginalUrl));
  }) || null;
}

function urlCandidatesFromElementAttributes(element, source, card) {
  const candidates = [];
  if (!element?.getAttribute) {
    return candidates;
  }

  for (const attr of URL_CANDIDATE_ATTRS) {
    const value = attr === "src" && element.currentSrc
      ? element.currentSrc
      : element.getAttribute(attr);
    collectUrlCandidateValue(candidates, value, source, card);
  }

  collectUrlCandidateValue(candidates, element.getAttribute("srcset"), source, card);
  return candidates;
}

function linkCandidatesFromRoot(root, card) {
  const candidates = [];
  const links = uniqueElements([
    root?.closest?.("a[href]"),
    ...(root?.querySelectorAll?.("a[href]") || [])
  ]).slice(0, 25);

  for (const link of links) {
    collectUrlCandidateValue(candidates, link.href || link.getAttribute("href"), "fallback-link", card);
  }

  return candidates;
}

function urlCandidatesFromVisibleText(root, card) {
  const text = root?.innerText || "";
  if (!text || text.length > 3000) {
    return [];
  }

  const candidates = [];
  collectUrlCandidateValue(candidates, text, "fallback-visible-text", card);
  return candidates;
}

function collectUrlCandidateValue(candidates, value, source, card) {
  const text = String(value || "").replace(/&amp;/g, "&");
  if (!text) {
    return;
  }

  if (source !== "fallback-visible-text" && text.includes(",")) {
    candidates.push(...srcSetCandidates(text, {
      width: card.width,
      height: card.height,
      source
    }));
  }

  for (const rawUrl of urlsFromText(text)) {
    const candidateUrl = normalizeOriginalDownloadUrl(rawUrl);
    const derived = Boolean(candidateUrl && canonicalUrl(candidateUrl) !== canonicalUrl(toAbsoluteUrl(rawUrl) || rawUrl));
    if (!candidateUrl) {
      continue;
    }
    if ((source === "fallback-link" || source === "fallback-visible-text")
      && !isStrongImageUrl(candidateUrl)
      && !isRetainableDownloadCandidateUrl(candidateUrl)) {
      continue;
    }

    candidates.push({
      url: candidateUrl,
      width: card.width,
      height: card.height,
      source,
      score: derived ? 800000 : 350000
    });
  }
}

function urlsFromText(text) {
  const urls = [];
  const trimmed = String(text || "").trim();
  const variants = Array.from(new Set([
    trimmed,
    trimmed
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&")
  ]));

  for (const variant of variants) {
    const direct = /^(https?:|\/\/|\/|\.{1,2}\/)/i.test(variant)
      ? toAbsoluteUrl(variant)
      : null;
    if (direct) {
      urls.push(direct);
    }

    for (const match of variant.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) {
      urls.push(match[0]);
    }
  }

  return Array.from(new Set(urls));
}

function imageResultFromCandidate(candidate, card) {
  return {
    url: candidate.url,
    date: card.date,
    prompt: card.prompt,
    alt: card.alt,
    width: Math.round(candidate.width || card.width || 0),
    height: Math.round(candidate.height || card.height || 0)
  };
}

async function prepareImageDownload(payload = {}) {
  const jobId = payload.jobId || "";
  const image = payload.image || {};
  const index = Number(payload.index || 0);
  const total = Number(payload.total || 0);
  const requestedUrl = toAbsoluteUrl(image.url);
  const url = normalizeOriginalDownloadUrl(requestedUrl || image.url);
  const urlSummary = summarizeUrl(image.url || "");
  const urlIntegrity = describeUrlIntegrity(url || image.url || "");
  const detailBase = {
    index,
    total,
    url: url ? summarizeUrl(url) : urlSummary,
    requestedUrl: requestedUrl ? summarizeUrl(requestedUrl) : urlSummary,
    normalizedFromThumbnail: Boolean(requestedUrl && url && canonicalUrl(requestedUrl) !== canonicalUrl(url)),
    urlIntegrity,
    pageImageContext: url ? summarizePageImageContext(url) : null
  };

  if (!url) {
    return failPreparedImage(jobId, "invalid-url", {
      ...detailBase,
      reason: "invalid-url"
    });
  }

  reportLog(jobId, "info", "已解析候选 URL，开始下载前取图", {
    ...detailBase,
    requestLocation: "content-script",
    requestMode: "fetch credentials=include referrer=strict-origin-when-cross-origin",
    requestHeaders: {
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*,*/*;q=0.8"
    }
  }, "download-prepare");

  let fetchResult = await fetchPreparedImageBlob(url);
  if (fetchResult.ok) {
    const prepared = await finalizePreparedImageBlob(jobId, fetchResult.blob, {
      ...detailBase,
      status: fetchResult.status,
      contentType: fetchResult.contentType,
      sourceUrl: fetchResult.responseUrl || url,
      requestLocation: "content-script",
      fetchMethod: "fetch",
      fallbackSource: ""
    });

    if (prepared.ok) {
      return prepared;
    }

    fetchResult = {
      ...fetchResult,
      ok: false,
      reason: prepared.reason || "quality-rejected",
      qualityFailure: prepared.diagnostic || null
    };

    reportLog(jobId, "warn", "fetch 得到的图片未通过原图质量校验，继续查找完整尺寸图片", {
      ...detailBase,
      qualityFailure: prepared.diagnostic || null
    }, "download-prepare");
  }

  reportLog(jobId, "warn", "Content fetch 未获取到图片，尝试页面图片 fallback", {
    ...detailBase,
    fetchFailure: summarizePreparationAttempt(fetchResult)
  }, "download-prepare");

  let detailFallbackResult = null;
  if (fetchResult.status === 403) {
    reportLog(jobId, "warn", "fetch original URL returned 403; continuing to search page resources for a full-size image", {
      ...detailBase,
      fetchFailure: summarizePreparationAttempt(fetchResult)
    }, "download-prepare");

    detailFallbackResult = await prepareImageFromDetailFallback({
      jobId,
      image,
      url,
      detailBase,
      fetchFailure: fetchResult
    });

    if (detailFallbackResult.ok) {
      return detailFallbackResult;
    }

    reportLog(jobId, "warn", "detail-fallback-failed: falling back to already loaded page resources", {
      ...detailBase,
      detailFailure: summarizePreparationAttempt(detailFallbackResult)
    }, "download-prepare");
  }

  const fallbackResult = await prepareImageFromPageFallback({
    jobId,
    image,
    url,
    detailBase,
    fetchFailure: fetchResult
  });

  if (fallbackResult.ok) {
    return fallbackResult;
  }

  return failPreparedImage(jobId, fallbackResult.reason || fetchResult.reason || "image-prepare-failed", {
    ...detailBase,
    reason: fallbackResult.reason || fetchResult.reason || "image-prepare-failed",
    status: fetchResult.status || 0,
    contentType: fetchResult.contentType || "",
    fetchFailure: summarizePreparationAttempt(fetchResult),
    detailFallbackFailure: detailFallbackResult ? summarizePreparationAttempt(detailFallbackResult) : null,
    fallbackFailure: summarizePreparationAttempt(fallbackResult),
    validation: {
      candidateUrlStillHasQuery: urlIntegrity.hasQuery,
      candidateUrlStillHasHash: urlIntegrity.hasHash,
      queryKeys: urlIntegrity.queryKeys,
      hasSignature: urlIntegrity.hasSignature,
      hasEstuaryId: urlIntegrity.hasEstuaryId,
      urlIntegrityIssue: urlIntegrity.integrityIssue,
      pageImageContext: detailBase.pageImageContext,
      fetchLocation: "content-script",
      detailFallbackLocationsTried: detailFallbackResult?.locationsTried || [],
      fallbackLocationsTried: fallbackResult.locationsTried || []
    }
  });
}

async function fetchPreparedImageBlob(url) {
  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "force-cache",
      redirect: "follow",
      referrer: location.href,
      referrerPolicy: "strict-origin-when-cross-origin",
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*,*/*;q=0.8"
      }
    });
  } catch (error) {
    return {
      ok: false,
      reason: "fetch-error",
      error: error?.message || String(error),
      requestLocation: "content-script",
      method: "fetch"
    };
  }

  const responseContentType = normalizeMimeType(response.headers.get("content-type") || "");
  if (!response.ok) {
    return {
      ok: false,
      reason: "http-not-ok",
      status: response.status,
      contentType: responseContentType,
      responseUrl: response.url || url,
      requestLocation: "content-script",
      method: "fetch"
    };
  }

  if (responseContentType && !isImageMimeType(responseContentType) && !canSniffImageMimeType(responseContentType)) {
    return {
      ok: false,
      reason: "non-image-response",
      status: response.status,
      contentType: responseContentType,
      responseUrl: response.url || url,
      requestLocation: "content-script",
      method: "fetch"
    };
  }

  try {
    return {
      ok: true,
      blob: await response.blob(),
      status: response.status,
      contentType: responseContentType,
      responseUrl: response.url || url,
      requestLocation: "content-script",
      method: "fetch"
    };
  } catch (error) {
    return {
      ok: false,
      reason: "blob-read-error",
      status: response.status,
      contentType: responseContentType,
      responseUrl: response.url || url,
      error: error?.message || String(error),
      requestLocation: "content-script",
      method: "fetch"
    };
  }
}

async function prepareImageFromDetailFallback({ jobId, image, url, detailBase, fetchFailure }) {
  const locationsTried = [];
  const card = findCardForDownloadImage(image, url);

  if (!card) {
    reportLog(jobId, "warn", "open-detail-view skipped: related thumbnail card was not found", {
      ...detailBase,
      fetchFailure: summarizePreparationAttempt(fetchFailure)
    }, "download-prepare");

    return {
      ok: false,
      reason: "detail-card-not-found",
      candidateCount: 0,
      locationsTried
    };
  }

  const beforeHref = location.href;
  const beforeUrls = currentImageUrlSet();

  reportLog(jobId, "info", "open-detail-view: direct fetch returned 403, opening image detail", {
    ...detailBase,
    thumbnail: summarizeUrl(card.thumbnailUrl),
    cardWidth: card.width || 0,
    cardHeight: card.height || 0,
    fetchFailure: summarizePreparationAttempt(fetchFailure)
  }, "download-prepare");

  try {
    const openResult = await openDetailForCard(card, {
      beforeUrls,
      beforeHref,
      timeoutMs: DETAIL_DOWNLOAD_OPEN_TIMEOUT_MS,
      jobId,
      index: detailBase.index,
      stage: "download-prepare"
    });
    locationsTried.push(...openResult.attempts.map((attempt) => `detail-open:${attempt.source}`));

    const detailRoot = openResult.root;
    if (!detailRoot) {
      reportLog(jobId, "warn", "detail-open-failed: no detail view or full-size image appeared", {
        ...detailBase,
        timeoutMs: DETAIL_DOWNLOAD_OPEN_TIMEOUT_MS,
        thumbnail: summarizeUrl(card.thumbnailUrl),
        openAttempts: openResult.attempts
      }, "download-prepare");

      return {
        ok: false,
        reason: "detail-not-opened",
        candidateCount: 0,
        locationsTried
      };
    }

    await sleep(DETAIL_SETTLE_MS);

    const candidates = collectDetailDownloadFallbackCandidates(detailRoot, url, image, card)
      .slice(0, 24);

    if (!candidates.length) {
      reportLog(jobId, "warn", "detail-no-original: detail view opened but no image download candidates were found", {
        ...detailBase,
        thumbnail: summarizeUrl(card.thumbnailUrl)
      }, "download-prepare");

      return {
        ok: false,
        reason: "detail-no-candidate",
        candidateCount: 0,
        locationsTried
      };
    }

    reportLog(jobId, "info", "detail-candidates-found: searching detail view for full-size original", {
      ...detailBase,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, 6).map(summarizeFallbackCandidate)
    }, "download-prepare");

    const result = await prepareImageFromDetailCandidates({
      jobId,
      candidates,
      detailBase,
      locationsTried
    });

    if (result.ok) {
      reportLog(jobId, "info", "detail-original-found: full-size image prepared from detail view", {
        ...detailBase,
        sourceUrl: result.sourceUrl ? summarizeUrl(result.sourceUrl) : null,
        width: result.width || 0,
        height: result.height || 0,
        size: result.size || 0,
        fetchMethod: result.fetchMethod || "",
        fallbackSource: result.fallbackSource || ""
      }, "download-prepare");
    }

    return result;
  } finally {
    await closeDetail(beforeHref);
  }
}

async function prepareImageFromDetailCandidates({ jobId, candidates, detailBase, locationsTried }) {
  const failures = [];

  for (const candidate of candidates) {
    const thumbnailRejection = describeThumbnailCandidateRejection(candidate);
    if (thumbnailRejection) {
      locationsTried.push("detail-thumbnail-rejected");
      failures.push(thumbnailRejection);
      reportLog(jobId, "warn", "thumbnail-candidate-rejected: refused to use thumbnail as original", {
        ...detailBase,
        rejection: thumbnailRejection
      }, "download-prepare");
      continue;
    }

    if (candidate.url) {
      locationsTried.push("detail-candidate-fetch");
      const candidateFetch = await fetchPreparedImageBlob(candidate.url);
      if (candidateFetch.ok) {
        const prepared = await finalizePreparedImageBlob(jobId, candidateFetch.blob, {
          ...detailBase,
          status: candidateFetch.status,
          contentType: candidateFetch.contentType,
          sourceUrl: candidateFetch.responseUrl || candidate.url,
          requestLocation: "content-script",
          fetchMethod: "detail-candidate-fetch",
          fallbackSource: candidate.source || "",
          width: candidate.width || 0,
          height: candidate.height || 0
        });

        if (prepared.ok) {
          return prepared;
        }

        failures.push({
          source: candidate.source || "",
          method: "detail-candidate-fetch",
          reason: prepared.reason || "quality-rejected",
          diagnostic: prepared.diagnostic || null,
          naturalWidth: candidate.width || 0,
          naturalHeight: candidate.height || 0,
          url: summarizeUrl(candidate.url)
        });
      } else {
        failures.push({
          source: candidate.source || "",
          method: "detail-candidate-fetch",
          reason: candidateFetch.reason || "fetch-failed",
          status: candidateFetch.status || 0,
          contentType: candidateFetch.contentType || "",
          error: candidateFetch.error || "",
          url: summarizeUrl(candidate.url)
        });
      }
    }

    if (candidate.element) {
      locationsTried.push("detail-existing-img");
      const existingImageResult = await blobFromExistingImageElement(candidate.element);
      if (existingImageResult.ok) {
        const prepared = await finalizePreparedImageBlob(jobId, existingImageResult.blob, {
          ...detailBase,
          status: 200,
          contentType: existingImageResult.mimeType || "",
          sourceUrl: candidate.url,
          requestLocation: "content-script",
          fetchMethod: "detail-existing-img-canvas",
          fallbackSource: candidate.source || "",
          width: existingImageResult.width || 0,
          height: existingImageResult.height || 0
        });

        if (prepared.ok) {
          return prepared;
        }

        failures.push({
          source: candidate.source || "",
          method: "detail-existing-img-canvas",
          reason: prepared.reason || "quality-rejected",
          diagnostic: prepared.diagnostic || null,
          naturalWidth: existingImageResult.width || 0,
          naturalHeight: existingImageResult.height || 0,
          url: summarizeUrl(candidate.url)
        });
      } else {
        failures.push({
          source: candidate.source || "",
          method: "detail-existing-img-canvas",
          reason: existingImageResult.reason,
          error: existingImageResult.error || "",
          naturalWidth: candidate.element?.naturalWidth || 0,
          naturalHeight: candidate.element?.naturalHeight || 0,
          url: summarizeUrl(candidate.url)
        });
      }
    }

    if (candidate.url) {
      locationsTried.push("detail-img-element-load");
      const loadedImageResult = await blobFromPageImageLoad(candidate.url);
      if (loadedImageResult.ok) {
        const prepared = await finalizePreparedImageBlob(jobId, loadedImageResult.blob, {
          ...detailBase,
          status: 200,
          contentType: loadedImageResult.mimeType || "",
          sourceUrl: candidate.url,
          requestLocation: "content-script",
          fetchMethod: "detail-img-element-load-canvas",
          fallbackSource: candidate.source || "",
          width: loadedImageResult.width || 0,
          height: loadedImageResult.height || 0
        });

        if (prepared.ok) {
          return prepared;
        }

        failures.push({
          source: candidate.source || "",
          method: "detail-img-element-load-canvas",
          reason: prepared.reason || "quality-rejected",
          diagnostic: prepared.diagnostic || null,
          naturalWidth: loadedImageResult.width || 0,
          naturalHeight: loadedImageResult.height || 0,
          url: summarizeUrl(candidate.url)
        });
      } else {
        failures.push({
          source: candidate.source || "",
          method: "detail-img-element-load-canvas",
          reason: loadedImageResult.reason,
          error: loadedImageResult.error || "",
          url: summarizeUrl(candidate.url)
        });
      }
    }
  }

  const qualityFailureReason = failures.some((failure) => failure.reason === "thumbnail-only")
    ? "thumbnail-only"
    : failures.some((failure) => failure.reason === "low-resolution")
      ? "low-resolution"
      : "";

  return {
    ok: false,
    reason: qualityFailureReason || (failures.length ? "detail-fallback-failed" : "detail-no-original"),
    candidateCount: candidates.length,
    failures: failures.slice(0, 8),
    locationsTried: Array.from(new Set(locationsTried))
  };
}

async function prepareImageFromPageFallback({ jobId, image, url, detailBase, fetchFailure }) {
  const candidates = collectPageDownloadFallbackCandidates(url, image).slice(0, 16);
  const locationsTried = [];
  const failures = [];

  if (!candidates.length) {
    return {
      ok: false,
      reason: "no-page-fallback-candidate",
      candidateCount: 0,
      locationsTried
    };
  }

  reportLog(jobId, "info", "已找到页面 fallback 候选，尝试使用浏览器已加载/图片元素请求", {
    ...detailBase,
    fetchFailure: summarizePreparationAttempt(fetchFailure),
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 5).map(summarizeFallbackCandidate)
  }, "download-prepare");

  for (const candidate of candidates) {
    if (candidate.element) {
      locationsTried.push("page-existing-img");
      const existingImageResult = await blobFromExistingImageElement(candidate.element);
      if (existingImageResult.ok) {
        const prepared = await finalizePreparedImageBlob(jobId, existingImageResult.blob, {
          ...detailBase,
          status: 200,
          contentType: existingImageResult.mimeType || "",
          sourceUrl: candidate.url,
          requestLocation: "content-script",
          fetchMethod: "page-existing-img-canvas",
          fallbackSource: candidate.source,
          width: existingImageResult.width || 0,
          height: existingImageResult.height || 0
        });

        if (prepared.ok) {
          return prepared;
        }

        failures.push({
          source: candidate.source,
          method: "page-existing-img-canvas",
          reason: prepared.reason || "quality-rejected",
          diagnostic: prepared.diagnostic || null,
          naturalWidth: existingImageResult.width || 0,
          naturalHeight: existingImageResult.height || 0,
          url: summarizeUrl(candidate.url)
        });

        continue;
      }

      failures.push({
        source: candidate.source,
        method: "page-existing-img-canvas",
        reason: existingImageResult.reason,
        error: existingImageResult.error || ""
      });
    }

    if (candidate.url) {
      locationsTried.push("page-img-element-load");
      const loadedImageResult = await blobFromPageImageLoad(candidate.url);
      if (loadedImageResult.ok) {
        const prepared = await finalizePreparedImageBlob(jobId, loadedImageResult.blob, {
          ...detailBase,
          status: 200,
          contentType: loadedImageResult.mimeType || "",
          sourceUrl: candidate.url,
          requestLocation: "content-script",
          fetchMethod: "page-img-element-load-canvas",
          fallbackSource: candidate.source,
          width: loadedImageResult.width || 0,
          height: loadedImageResult.height || 0
        });

        if (prepared.ok) {
          return prepared;
        }

        failures.push({
          source: candidate.source,
          method: "page-img-element-load-canvas",
          reason: prepared.reason || "quality-rejected",
          diagnostic: prepared.diagnostic || null,
          naturalWidth: loadedImageResult.width || 0,
          naturalHeight: loadedImageResult.height || 0,
          url: summarizeUrl(candidate.url)
        });

        continue;
      }

      failures.push({
        source: candidate.source,
        method: "page-img-element-load-canvas",
        reason: loadedImageResult.reason,
        error: loadedImageResult.error || "",
        url: summarizeUrl(candidate.url)
      });
    }
  }

  const qualityFailureReason = failures.some((failure) => failure.reason === "thumbnail-only")
    ? "thumbnail-only"
    : failures.some((failure) => failure.reason === "low-resolution")
      ? "low-resolution"
      : "";

  return {
    ok: false,
    reason: qualityFailureReason || (failures.length ? "page-fallback-failed" : "no-page-fallback-candidate"),
    candidateCount: candidates.length,
    failures: failures.slice(0, 6),
    locationsTried: Array.from(new Set(locationsTried))
  };
}

async function finalizePreparedImageBlob(jobId, blob, context = {}) {
  const sniffedType = await detectImageMimeType(blob);
  const mimeType = normalizeMimeType(blob.type || context.contentType || sniffedType);
  const verifiedMimeType = isImageMimeType(mimeType) ? mimeType : sniffedType;
  const extension = extensionFromMimeType(verifiedMimeType);

  if (!extension) {
    return failPreparedImage(jobId, "non-image-blob", {
      ...context,
      blobType: blob.type || "",
      size: blob.size
    });
  }

  const dimensions = await readImageBlobDimensions(blob);
  const quality = validateOriginalImageQuality(blob, {
    ...context,
    mimeType: verifiedMimeType
  }, dimensions);

  if (!quality.ok) {
    return failPreparedImage(jobId, quality.reason, {
      ...context,
      blobType: blob.type || "",
      mimeType: verifiedMimeType,
      size: blob.size,
      quality: quality.detail,
      validation: quality.detail
    });
  }

  const downloadUrl = URL.createObjectURL(blob);
  rememberPreparedImageDownload(downloadUrl, {
    blob,
    extension,
    mimeType: verifiedMimeType,
    sourceUrl: context.sourceUrl || ""
  });

  const result = {
    ok: true,
    downloadUrl,
    downloadUrlKind: "blob",
    extension,
    mimeType: verifiedMimeType,
    size: blob.size,
    status: context.status || 200,
    contentType: context.contentType || verifiedMimeType,
    urlSummary: context.url || summarizeUrl(context.sourceUrl || ""),
    fetchMethod: context.fetchMethod || "",
    fallbackSource: context.fallbackSource || "",
    sourceUrl: context.sourceUrl || "",
    width: quality.detail.width || 0,
    height: quality.detail.height || 0,
    quality: quality.detail
  };

  reportLog(jobId, "info", "original-download-success", {
    sourceUrl: context.sourceUrl ? summarizeUrl(context.sourceUrl) : null,
    mimeType: result.mimeType,
    extension: result.extension,
    size: result.size,
    width: result.width,
    height: result.height,
    quality: result.quality,
    downloadUrlKind: result.downloadUrlKind,
    fetchMethod: result.fetchMethod,
    fallbackSource: result.fallbackSource
  }, "download-prepare");

  reportLog(jobId, "info", "已成功获取图片 Blob，准备提交浏览器下载", {
    ...context,
    sourceUrl: context.sourceUrl ? summarizeUrl(context.sourceUrl) : null,
    mimeType: result.mimeType,
    extension: result.extension,
    size: result.size,
    width: result.width,
    height: result.height,
    quality: result.quality,
    downloadUrlKind: result.downloadUrlKind,
    fetchMethod: result.fetchMethod,
    fallbackSource: result.fallbackSource
  }, "download-prepare");

  return result;
}

function failPreparedImage(jobId, reason, detail) {
  const result = {
    ok: false,
    reason,
    status: detail?.status || 0,
    contentType: detail?.contentType || "",
    urlSummary: detail?.url || null,
    diagnostic: detail?.validation || detail || null
  };

  if (reason === "thumbnail-only" || reason === "low-resolution") {
    reportLog(jobId, "warn", reason === "thumbnail-only"
      ? "thumbnail-only: refused to save thumbnail as original"
      : "low-resolution: fallback image dimensions or blob size are insufficient", detail, "download-prepare");
  }

  reportLog(jobId, "warn", "下载前取图失败，未提交下载任务", detail, "download-prepare");
  return result;
}

async function readImageBlobDimensions(blob) {
  if (!blob?.size) {
    return { width: 0, height: 0, error: "empty-blob" };
  }

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      const dimensions = {
        width: bitmap.width || 0,
        height: bitmap.height || 0
      };
      bitmap.close?.();
      return dimensions;
    } catch {
      // Fall through to Image decoding for browsers that reject this blob type.
    }
  }

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      URL.revokeObjectURL(objectUrl);
      img.remove?.();
      resolve(result);
    };
    const timeoutId = setTimeout(() => {
      finish({ width: 0, height: 0, error: "dimension-decode-timeout" });
    }, 5000);

    img.addEventListener("load", () => {
      finish({
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0
      });
    }, { once: true });
    img.addEventListener("error", () => {
      finish({ width: 0, height: 0, error: "dimension-decode-error" });
    }, { once: true });
    img.src = objectUrl;
  });
}

function validateOriginalImageQuality(blob, context = {}, dimensions = {}) {
  const width = Math.max(dimensions.width || 0, context.width || 0, context.naturalWidth || 0);
  const height = Math.max(dimensions.height || 0, context.height || 0, context.naturalHeight || 0);
  const sourceUrl = context.sourceUrl || "";
  const fetchMethod = context.fetchMethod || context.method || "";
  const fallbackSource = context.fallbackSource || "";
  const sourceHasThumbnailMarker = hasThumbnailMarkerInUrl(sourceUrl);
  const sourceLooksLikeThumbnail = sourceUrlLooksLikeThumbnail(sourceUrl);
  const isCanvasFallback = /canvas/i.test(fetchMethod);
  const is512Thumbnail = Boolean(width && height && width <= THUMBNAIL_MAX_DIMENSION && height <= THUMBNAIL_MAX_DIMENSION);
  const lowResolutionArea = Boolean(width && height && width * height < MIN_ORIGINAL_DIMENSION * MIN_ORIGINAL_DIMENSION);
  const smallBlob = Boolean(blob?.size && blob.size < MIN_ORIGINAL_BLOB_SIZE_BYTES);
  const detail = {
    sourceUrl: sourceUrl ? summarizeUrl(sourceUrl) : null,
    sourceHasThumbnailMarker,
    sourceLooksLikeThumbnail,
    width,
    height,
    naturalWidth: width,
    naturalHeight: height,
    size: blob?.size || 0,
    minExpectedDimension: MIN_ORIGINAL_DIMENSION,
    minExpectedBlobSize: MIN_ORIGINAL_BLOB_SIZE_BYTES,
    fetchMethod,
    fallbackSource,
    isCanvasFallback,
    dimensionDecodeError: dimensions.error || ""
  };

  if (sourceHasThumbnailMarker || sourceLooksLikeThumbnail || is512Thumbnail) {
    return {
      ok: false,
      reason: "thumbnail-only",
      detail: {
        ...detail,
        rejected: true,
        rejection: sourceHasThumbnailMarker || sourceLooksLikeThumbnail
          ? "source-url-looks-like-thumbnail"
          : "natural-size-at-or-below-512"
      }
    };
  }

  if ((isCanvasFallback && (lowResolutionArea || smallBlob))
    || (lowResolutionArea && smallBlob)) {
    return {
      ok: false,
      reason: "low-resolution",
      detail: {
        ...detail,
        rejected: true,
        rejection: "fallback-dimensions-or-blob-size-too-small"
      }
    };
  }

  return {
    ok: true,
    reason: "",
    detail: {
      ...detail,
      rejected: false
    }
  };
}

function describeUrlIntegrity(url) {
  try {
    const parsed = new URL(url, location.href);
    const info = estuaryContentInfo(parsed.href);
    const queryKeys = Array.from(new Set(Array.from(parsed.searchParams.keys()))).slice(0, 20);
    let integrityIssue = "";

    if (info?.isEstuaryContent && !info.id) {
      integrityIssue = "missing-estuary-id";
    } else if (info?.isEstuaryContent && !parsed.search) {
      integrityIssue = "missing-query";
    }

    return {
      fullUrlLength: parsed.href.length,
      hasQuery: parsed.search.length > 1,
      queryLength: parsed.search.length,
      queryKeys,
      hasHash: parsed.hash.length > 0,
      hashLength: parsed.hash.length,
      hasSignature: Boolean(info?.hasSignature || hasSignatureLikeSearchParam(parsed.searchParams)),
      hasEstuaryId: Boolean(info?.id),
      hasThumbnailMarker: Boolean(info?.hasThumbnailMarker),
      integrityIssue
    };
  } catch {
    return {
      fullUrlLength: String(url || "").length,
      hasQuery: String(url || "").includes("?"),
      queryLength: 0,
      queryKeys: [],
      hasHash: String(url || "").includes("#"),
      hashLength: 0,
      hasSignature: false,
      hasEstuaryId: false,
      hasThumbnailMarker: false,
      integrityIssue: "invalid-url"
    };
  }
}

function summarizePageImageContext(targetUrl) {
  const samples = [];
  let relatedImageCount = 0;

  for (const img of document.images) {
    const urls = [img.currentSrc, img.src]
      .map((value) => toAbsoluteUrl(value))
      .filter(Boolean);

    if (!urls.some((url) => isRelatedImageDownloadUrl(targetUrl, url))) {
      continue;
    }

    relatedImageCount += 1;
    if (samples.length >= 3) {
      continue;
    }

    samples.push({
      currentSrc: img.currentSrc ? summarizeUrl(img.currentSrc) : null,
      src: img.src ? summarizeUrl(img.src) : null,
      complete: Boolean(img.complete),
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0
    });
  }

  return {
    relatedImageCount,
    samples
  };
}

function summarizePreparationAttempt(attempt = {}) {
  return {
    reason: attempt.reason || "",
    status: attempt.status || 0,
    contentType: attempt.contentType || "",
    requestLocation: attempt.requestLocation || "",
    method: attempt.method || attempt.fetchMethod || "",
    error: attempt.error || "",
    qualityFailure: attempt.qualityFailure || undefined,
    candidateCount: attempt.candidateCount || 0,
    failures: Array.isArray(attempt.failures) ? attempt.failures.slice(0, 3) : undefined,
    locationsTried: Array.isArray(attempt.locationsTried) ? attempt.locationsTried : undefined
  };
}

function findCardForDownloadImage(image = {}, targetUrl = "") {
  const targetUrls = [
    targetUrl,
    image.url,
    image.sourceUrl,
    image.originalUrl,
    image.downloadUrl
  ].filter(Boolean);
  const targetIds = new Set(targetUrls.map(normalizedEstuaryContentId).filter(Boolean));
  let best = null;
  let bestScore = 0;

  for (const img of document.images) {
    const card = imageCardFromElement(img);
    if (!card) {
      continue;
    }

    const cardUrls = [
      card.thumbnailUrl,
      card.derivedOriginalUrl,
      img.currentSrc,
      img.src
    ].filter(Boolean);
    let score = 0;

    for (const cardUrl of cardUrls) {
      const cardId = normalizedEstuaryContentId(cardUrl);
      if (cardId && targetIds.has(cardId)) {
        score += 3000;
      }

      if (targetUrls.some((url) => isRelatedImageDownloadUrl(url, cardUrl))) {
        score += 2000;
      }
    }

    if (!score) {
      continue;
    }

    score += Math.min(Math.round((card.width || 0) * (card.height || 0) / 1000), 1000);
    if (score > bestScore) {
      best = card;
      bestScore = score;
    }
  }

  return best;
}

function collectDetailDownloadFallbackCandidates(detailRoot, targetUrl, image = {}, card = null) {
  const candidates = new Map();
  const target = toAbsoluteUrl(targetUrl);
  const add = (rawUrl, source, element = null, options = {}, requireRelation = false) => {
    const absoluteUrl = toAbsoluteUrl(rawUrl);
    if (!absoluteUrl || isUiAssetUrl(absoluteUrl)) {
      return;
    }

    const originalUrl = normalizeOriginalDownloadUrl(absoluteUrl);
    if (!originalUrl || isUiAssetUrl(originalUrl)) {
      return;
    }

    const strongCandidate = isStrongImageUrl(originalUrl)
      || isRetainableDownloadCandidateUrl(originalUrl)
      || IMAGE_URL_RE.test(originalUrl);
    if (!strongCandidate) {
      return;
    }

    if (requireRelation && target && !isRelatedImageDownloadUrl(target, originalUrl)) {
      return;
    }

    const normalizedFromThumbnail = canonicalUrl(originalUrl) !== canonicalUrl(absoluteUrl);
    const rawLooksLikeThumbnail = hasThumbnailMarkerInUrl(absoluteUrl) || sourceUrlLooksLikeThumbnail(absoluteUrl);
    const usableElement = normalizedFromThumbnail || rawLooksLikeThumbnail ? null : element;
    const width = Math.max(options.width || 0, element?.naturalWidth || 0);
    const height = Math.max(options.height || 0, element?.naturalHeight || 0);
    const key = canonicalUrl(originalUrl);
    const score = Number(options.score || 0)
      + Math.round(width * height)
      + (usableElement ? 550000 : 0)
      + (source === "detail-link" ? 450000 : 0)
      + (source === "detail-download-link" ? 900000 : 0)
      + (normalizedFromThumbnail ? 150000 : 0)
      - (rawLooksLikeThumbnail ? 900000 : 0);
    const next = {
      url: originalUrl,
      rawUrl: absoluteUrl,
      source: normalizedFromThumbnail ? `${source}-originalized` : source,
      element: usableElement,
      width,
      height,
      score,
      normalizedFromThumbnail,
      rawLooksLikeThumbnail
    };
    const existing = candidates.get(key);

    if (!existing || next.score > existing.score) {
      candidates.set(key, next);
    }
  };

  add(target, "candidate-url", null, {
    width: image.width || card?.width || 0,
    height: image.height || card?.height || 0,
    score: 300000
  });

  for (const img of detailRoot.querySelectorAll("img")) {
    for (const candidate of imageUrlCandidatesFromElement(img, "detail-img")) {
      add(candidate.url, candidate.source || "detail-img", img, {
        width: candidate.width,
        height: candidate.height,
        score: candidate.score || 0
      });
    }

    for (const attrCandidate of urlCandidatesFromElementAttributes(img, "detail-img-attr", {
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0
    })) {
      add(attrCandidate.url, attrCandidate.source || "detail-img-attr", img, {
        width: attrCandidate.width,
        height: attrCandidate.height,
        score: attrCandidate.score || 0
      });
    }
  }

  for (const source of detailRoot.querySelectorAll("source[srcset]")) {
    const rect = source.parentElement?.getBoundingClientRect?.();
    for (const candidate of srcSetCandidates(source.getAttribute("srcset"), {
      width: rect?.width || 0,
      height: rect?.height || 0,
      source: "detail-source"
    })) {
      add(candidate.url, candidate.source, null, {
        width: candidate.width,
        height: candidate.height,
        score: candidate.score || 0
      });
    }
  }

  for (const link of detailRoot.querySelectorAll("a[href]")) {
    const label = [
      link.textContent,
      link.getAttribute("aria-label"),
      link.getAttribute("title")
    ].filter(Boolean).join(" ");
    const hasDownloadIntent = link.hasAttribute("download") || /download|下载/i.test(label);
    add(link.href || link.getAttribute("href"), hasDownloadIntent ? "detail-download-link" : "detail-link", null, {
      score: hasDownloadIntent ? 700000 : 200000
    });
  }

  for (const element of [detailRoot, ...Array.from(detailRoot.querySelectorAll("*")).slice(0, 800)]) {
    const rect = element.getBoundingClientRect?.();
    for (const attr of URL_CANDIDATE_ATTRS) {
      add(element.getAttribute?.(attr), "detail-attr", element instanceof HTMLImageElement ? element : null, {
        width: rect?.width || 0,
        height: rect?.height || 0,
        score: 150000
      });
    }

    const style = element.getAttribute?.("style") || "";
    for (const match of style.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
      add(match[1], "detail-style", null, {
        width: rect?.width || 0,
        height: rect?.height || 0,
        score: 180000
      });
    }
  }

  for (const rawUrl of urlsFromText(detailRoot.textContent || "").slice(0, 80)) {
    add(rawUrl, "detail-text", null, {
      score: 100000
    });
  }

  try {
    const entries = performance.getEntriesByType("resource")
      .slice(-DIRECT_RESOURCE_CANDIDATE_LIMIT);

    for (const entry of entries) {
      add(entry.name, "detail-performance-resource", null, {
        score: 300000
      }, true);
    }
  } catch {
    // Resource timing is a best-effort fallback source.
  }

  const targetId = normalizedEstuaryContentId(target);
  if (targetId) {
    const idNeedle = targetId.slice(0, 18);
    for (const script of Array.from(document.querySelectorAll("script:not([src])")).slice(-100)) {
      const text = script.textContent || "";
      if (!text.includes(idNeedle)) {
        continue;
      }

      for (const rawUrl of urlsFromText(text).slice(0, 80)) {
        add(rawUrl, "detail-embedded-data", null, {
          score: 260000
        }, true);
      }
    }
  }

  return Array.from(candidates.values())
    .sort((a, b) => b.score - a.score);
}

function describeThumbnailCandidateRejection(candidate = {}) {
  const rawUrl = candidate.rawUrl || candidate.url || "";
  const url = candidate.url || "";
  const width = candidate.element?.naturalWidth || candidate.width || 0;
  const height = candidate.element?.naturalHeight || candidate.height || 0;
  const hasMarker = hasThumbnailMarkerInUrl(rawUrl) || hasThumbnailMarkerInUrl(url);
  const looksLikeThumbnail = candidate.rawLooksLikeThumbnail
    || sourceUrlLooksLikeThumbnail(rawUrl)
    || sourceUrlLooksLikeThumbnail(url);
  const is512Thumbnail = Boolean(width && height && width <= THUMBNAIL_MAX_DIMENSION && height <= THUMBNAIL_MAX_DIMENSION);

  if (!hasMarker && !looksLikeThumbnail && !is512Thumbnail) {
    return null;
  }

  return {
    source: candidate.source || "",
    reason: "thumbnail-only",
    url: summarizeUrl(url),
    rawUrl: rawUrl && rawUrl !== url ? summarizeUrl(rawUrl) : null,
    hasThumbnailMarker: hasMarker,
    looksLikeThumbnail,
    naturalWidth: width,
    naturalHeight: height,
    rejection: hasMarker || looksLikeThumbnail
      ? "source-url-looks-like-thumbnail"
      : "natural-size-at-or-below-512"
  };
}

function collectPageDownloadFallbackCandidates(targetUrl, image = {}) {
  const candidates = new Map();
  const target = toAbsoluteUrl(targetUrl);
  const add = (rawUrl, source, element = null, options = {}) => {
    const absoluteUrl = toAbsoluteUrl(rawUrl);
    if (!absoluteUrl || isUiAssetUrl(absoluteUrl) || !isLikelyImageUrl(absoluteUrl)) {
      return;
    }

    const originalUrl = normalizeOriginalDownloadUrl(absoluteUrl);
    if (!originalUrl || isUiAssetUrl(originalUrl) || !isLikelyImageUrl(originalUrl)) {
      return;
    }

    if (source !== "candidate-url" && !isRelatedImageDownloadUrl(target, originalUrl)) {
      return;
    }

    const normalizedFromThumbnail = canonicalUrl(originalUrl) !== canonicalUrl(absoluteUrl);
    const rawLooksLikeThumbnail = hasThumbnailMarkerInUrl(absoluteUrl) || sourceUrlLooksLikeThumbnail(absoluteUrl);
    const usableElement = normalizedFromThumbnail || rawLooksLikeThumbnail
      ? null
      : element;
    const key = canonicalUrl(originalUrl);
    const score = Number(options.score || 0)
      + Math.round((options.width || 0) * (options.height || 0))
      + (usableElement ? 500000 : 0)
      + (normalizedFromThumbnail ? 450000 : 0);
    const next = {
      url: originalUrl,
      rawUrl: absoluteUrl,
      source: normalizedFromThumbnail ? `${source}-originalized` : source,
      element: usableElement,
      width: options.width || 0,
      height: options.height || 0,
      score,
      normalizedFromThumbnail,
      rawLooksLikeThumbnail
    };
    const existing = candidates.get(key);

    if (!existing || next.score > existing.score) {
      candidates.set(key, next);
    }
  };

  add(target, "candidate-url", null, {
    width: image.width || 0,
    height: image.height || 0,
    score: 1000000
  });

  for (const img of document.images) {
    for (const candidate of imageUrlCandidatesFromElement(img, "page-img")) {
      add(candidate.url, candidate.source || "page-img", img, {
        width: candidate.width,
        height: candidate.height,
        score: candidate.score || 0
      });
    }
  }

  for (const source of document.querySelectorAll("source[srcset]")) {
    const rect = source.parentElement?.getBoundingClientRect?.();
    for (const candidate of srcSetCandidates(source.getAttribute("srcset"), {
      width: rect?.width || 0,
      height: rect?.height || 0,
      source: "page-source"
    })) {
      add(candidate.url, candidate.source, null, {
        width: candidate.width,
        height: candidate.height,
        score: candidate.score || 0
      });
    }
  }

  for (const link of document.querySelectorAll("a[href]")) {
    add(link.href || link.getAttribute("href"), "page-link", null, {
      score: link.hasAttribute("download") ? 600000 : 150000
    });
  }

  try {
    const entries = performance.getEntriesByType("resource")
      .slice(-DIRECT_RESOURCE_CANDIDATE_LIMIT);

    for (const entry of entries) {
      add(entry.name, "performance-resource", null, {
        score: 250000
      });
    }
  } catch {
    // Performance resources are a best-effort fallback source.
  }

  const targetId = normalizedEstuaryContentId(target);
  if (targetId) {
    const idNeedle = targetId.slice(0, 18);
    for (const script of Array.from(document.querySelectorAll("script:not([src])")).slice(-80)) {
      const text = script.textContent || "";
      if (!text.includes(idNeedle)) {
        continue;
      }

      for (const rawUrl of urlsFromText(text).slice(0, 40)) {
        add(rawUrl, "embedded-data", null, {
          score: 200000
        });
      }
    }
  }

  return Array.from(candidates.values())
    .sort((a, b) => b.score - a.score);
}

function summarizeFallbackCandidate(candidate) {
  return {
    source: candidate.source || "",
    url: candidate.url ? summarizeUrl(candidate.url) : null,
    rawUrl: candidate.rawUrl && candidate.rawUrl !== candidate.url ? summarizeUrl(candidate.rawUrl) : null,
    hasElement: Boolean(candidate.element),
    normalizedFromThumbnail: Boolean(candidate.normalizedFromThumbnail),
    rawLooksLikeThumbnail: Boolean(candidate.rawLooksLikeThumbnail),
    complete: Boolean(candidate.element?.complete),
    naturalWidth: candidate.element?.naturalWidth || candidate.width || 0,
    naturalHeight: candidate.element?.naturalHeight || candidate.height || 0
  };
}

async function blobFromExistingImageElement(img) {
  if (!img?.complete || !img.naturalWidth || !img.naturalHeight) {
    return {
      ok: false,
      reason: "image-not-loaded",
      method: "page-existing-img-canvas"
    };
  }

  return canvasBlobFromImage(img, "page-existing-img-canvas");
}

function blobFromPageImageLoad(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    let timeoutId = null;

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      img.remove();
      resolve(result);
    };

    img.addEventListener("load", async () => {
      finish(await canvasBlobFromImage(img, "page-img-element-load-canvas"));
    }, { once: true });

    img.addEventListener("error", () => {
      finish({
        ok: false,
        reason: "image-load-error",
        method: "page-img-element-load-canvas"
      });
    }, { once: true });

    timeoutId = setTimeout(() => {
      finish({
        ok: false,
        reason: "image-load-timeout",
        method: "page-img-element-load-canvas"
      });
    }, timeoutMs);

    img.decoding = "async";
    img.referrerPolicy = "strict-origin-when-cross-origin";
    img.style.position = "fixed";
    img.style.left = "-10000px";
    img.style.top = "0";
    img.style.width = "1px";
    img.style.height = "1px";
    img.style.opacity = "0";
    img.style.pointerEvents = "none";
    document.documentElement.appendChild(img);
    img.src = url;
  });
}

async function canvasBlobFromImage(img, method) {
  const width = img.naturalWidth || img.width || 0;
  const height = img.naturalHeight || img.height || 0;

  if (!width || !height) {
    return {
      ok: false,
      reason: "image-has-no-natural-size",
      method
    };
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return {
        ok: false,
        reason: "canvas-context-unavailable",
        method
      };
    }

    context.drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });

    if (!blob) {
      return {
        ok: false,
        reason: "canvas-to-blob-empty",
        method
      };
    }

    return {
      ok: true,
      blob,
      mimeType: blob.type || "image/png",
      method,
      width,
      height
    };
  } catch (error) {
    return {
      ok: false,
      reason: "canvas-read-failed",
      error: error?.message || String(error),
      method
    };
  }
}

function isRelatedImageDownloadUrl(targetUrl, candidateUrl) {
  if (!targetUrl || !candidateUrl) {
    return false;
  }

  const targetKey = canonicalUrl(targetUrl);
  const candidateKey = canonicalUrl(candidateUrl);
  if (targetKey && candidateKey && targetKey === candidateKey) {
    return true;
  }

  const derivedTarget = deriveOriginalUrlFromThumbnail(targetUrl) || targetUrl;
  const derivedCandidate = deriveOriginalUrlFromThumbnail(candidateUrl) || candidateUrl;
  if (canonicalUrl(derivedTarget) === canonicalUrl(derivedCandidate)) {
    return true;
  }

  const targetId = normalizedEstuaryContentId(targetUrl);
  const candidateId = normalizedEstuaryContentId(candidateUrl);
  if (targetId && candidateId && targetId === candidateId) {
    return true;
  }

  if (targetId) {
    try {
      return decodeURIComponent(candidateUrl).includes(targetId);
    } catch {
      return candidateUrl.includes(targetId);
    }
  }

  return false;
}

function normalizedEstuaryContentId(url) {
  const id = estuaryContentInfo(url)?.id || "";
  return id.replace(/#thumbnail$/i, "");
}

async function getPreparedImageDataUrl(payload = {}) {
  const downloadUrl = payload.downloadUrl || "";
  const prepared = preparedImageDownloads.get(downloadUrl);

  if (!prepared?.blob) {
    return {
      ok: false,
      reason: "prepared-blob-not-found"
    };
  }

  const dataUrl = await blobToDataUrl(prepared.blob);
  return {
    ok: true,
    downloadUrl: dataUrl,
    downloadUrlKind: "data",
    extension: prepared.extension,
    mimeType: prepared.mimeType,
    size: prepared.blob.size
  };
}

function rememberPreparedImageDownload(downloadUrl, entry) {
  const timeoutId = setTimeout(() => {
    revokePreparedImageDownload(downloadUrl);
  }, PREPARED_IMAGE_OBJECT_URL_TTL_MS);

  preparedImageDownloads.set(downloadUrl, {
    ...entry,
    timeoutId
  });
}

function revokePreparedImageDownload(downloadUrl) {
  const prepared = preparedImageDownloads.get(downloadUrl);
  if (!prepared) {
    return;
  }

  clearTimeout(prepared.timeoutId);
  preparedImageDownloads.delete(downloadUrl);

  try {
    URL.revokeObjectURL(downloadUrl);
  } catch {
    // Object URL cleanup is best-effort.
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error || new Error("Failed to read blob.")));
    reader.readAsDataURL(blob);
  });
}

async function detectImageMimeType(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());

  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50) {
    return "image/webp";
  }

  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.slice(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif";
    }
  }

  if (bytes.length >= 12) {
    const boxType = String.fromCharCode(...bytes.slice(4, 12));
    if (boxType === "ftypavif" || boxType === "ftypavis") {
      return "image/avif";
    }
  }

  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }

  return "";
}

function normalizeMimeType(value) {
  return String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function canSniffImageMimeType(mimeType) {
  return !mimeType
    || mimeType === "application/octet-stream"
    || mimeType === "binary/octet-stream";
}

function isImageMimeType(mimeType) {
  return Boolean(extensionFromMimeType(mimeType));
}

function extensionFromMimeType(mimeType) {
  return IMAGE_MIME_EXTENSIONS[normalizeMimeType(mimeType)] || "";
}

function uniqueElements(elements) {
  return Array.from(new Set(elements.filter(Boolean)));
}

async function checkImageReachability(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      cache: "no-store"
    });

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        contentLength: response.headers.get("content-length") || ""
      };
    }

    return {
      ok: response.status === 405,
      status: response.status,
      reason: response.status === 405 ? "head-not-allowed" : "http-not-ok"
    };
  } catch {
    return {
      ok: true,
      reason: "head-check-failed-assume-usable"
    };
  }
}

async function openDetailForCard(card, options = {}) {
  const beforeUrls = options.beforeUrls || currentImageUrlSet();
  const beforeHref = options.beforeHref || location.href;
  const timeoutMs = Math.max(Number(options.timeoutMs || DEFAULT_DETAIL_OPEN_TIMEOUT_MS), 1000);
  const startedAt = Date.now();
  const attempts = [];
  const targets = detailOpenTargets(card);

  for (const target of targets) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }

    try {
      target.element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    } catch {
      target.element.scrollIntoView({ block: "center", inline: "center" });
    }

    await sleep(120);
    const point = centerPointForElement(card.imageElement || target.element);
    clickElement(target.element, point);
    attempts.push({
      source: target.source,
      tag: target.element?.tagName || "",
      role: target.element?.getAttribute?.("role") || "",
      cursor: safeComputedStyle(target.element)?.cursor || "",
      width: Math.round(target.element?.getBoundingClientRect?.().width || 0),
      height: Math.round(target.element?.getBoundingClientRect?.().height || 0)
    });

    const root = await waitForDetailRoot(beforeUrls, beforeHref, Math.min(remainingMs, 1400));
    if (root) {
      reportLog(options.jobId || "", "info", "detail-opened", {
        index: options.index || 0,
        attempt: attempts[attempts.length - 1],
        attemptCount: attempts.length
      }, options.stage || "resolve");
      return { root, attempts };
    }
  }

  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs > 0) {
    const root = await waitForDetailRoot(beforeUrls, beforeHref, remainingMs);
    if (root) {
      return { root, attempts };
    }
  }

  return { root: null, attempts };
}

function detailOpenTargets(card) {
  const targets = [];
  const add = (element, source, score = 0) => {
    if (!element || element === document || element === document.documentElement || !document.contains(element)) {
      return;
    }

    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.width < 8 || rect.height < 8) {
      return;
    }

    const key = element;
    if (targets.some((target) => target.element === key)) {
      return;
    }

    targets.push({ element, source, score });
  };

  const image = card.imageElement || card.element;
  const imagePoint = centerPointForElement(image);
  const hitTarget = imagePoint
    ? document.elementFromPoint(imagePoint.clientX, imagePoint.clientY)
    : null;

  add(hitTarget, "element-from-point", 1000);
  add(card.element, "card-click-target", 900);
  add(image, "image", 800);

  let current = image;
  const imageRect = image?.getBoundingClientRect?.();
  const imageArea = Math.max((imageRect?.width || 0) * (imageRect?.height || 0), 1);

  for (let depth = 0; current && current !== document.body && depth < 12; depth += 1) {
    const style = safeComputedStyle(current);
    const rect = current.getBoundingClientRect?.();
    const area = (rect?.width || 0) * (rect?.height || 0);
    const role = current.getAttribute?.("role") || "";
    const testId = current.getAttribute?.("data-testid") || "";
    const className = typeof current.className === "string" ? current.className : "";
    const hasSemanticClick = current.matches?.("a[href], button, [role='button'], [tabindex]") && !current.disabled;
    const pointerLike = style?.cursor === "pointer" || /cursor-pointer/.test(className);
    const cardLike = /image|asset|card|tile|thumbnail|gallery|grid/i.test(`${testId} ${className} ${role}`);
    const reasonableCard = area >= imageArea * 0.8 && area <= Math.max(imageArea * 8, 600000);

    if (hasSemanticClick || pointerLike || (cardLike && reasonableCard)) {
      add(current, `ancestor-${depth}`, 700 - depth);
    } else if (reasonableCard && depth > 0 && depth <= 6) {
      add(current, `ancestor-fallback-${depth}`, 350 - depth);
    }

    current = current.parentElement;
  }

  return targets.sort((a, b) => b.score - a.score);
}

async function waitForDetailRoot(beforeUrls, beforeHref, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const dialogRoot = findVisibleDetailRoot(beforeUrls);
    if (dialogRoot) {
      return dialogRoot;
    }

    if (hasNewLargeImage(document.body, beforeUrls)) {
      return document.body;
    }

    await sleep(150);
  }

  return location.href !== beforeHref ? document.body : null;
}

function isSameSmallThumbnail(candidate, card) {
  if (canonicalUrl(candidate.url) !== canonicalUrl(card.thumbnailUrl)) {
    return false;
  }

  const originalArea = (candidate.width || 0) * (candidate.height || 0);
  const thumbnailArea = (card.width || 0) * (card.height || 0);
  const candidateLooks512Thumbnail = Boolean(
    (candidate.width || 0) && (candidate.height || 0)
    && candidate.width <= THUMBNAIL_MAX_DIMENSION
    && candidate.height <= THUMBNAIL_MAX_DIMENSION
  );

  if (candidateLooks512Thumbnail) {
    return true;
  }

  if (isRetainableDownloadCandidateUrl(candidate.url)) {
    return false;
  }

  return !originalArea || !thumbnailArea || originalArea <= thumbnailArea * 1.5;
}

function ensureJobActive(jobId) {
  if (!activeScanJobs.has(jobId)) {
    throw new Error("任务已取消。");
  }
}

function reportProgress(jobId, payload) {
  try {
    chrome.runtime.sendMessage({
      type: "IMAGE_JOB_PROGRESS",
      payload: {
        jobId,
        matched: 0,
        detailFailureCount: 0,
        current: 0,
        ...payload
      }
    }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // Progress updates are best-effort; the final scan response still carries the result.
  }
}

function reportLog(jobId, level, message, detail = null, stage = "resolve") {
  try {
    chrome.runtime.sendMessage({
      type: "IMAGE_JOB_LOG",
      payload: {
        jobId,
        level,
        source: "content",
        stage,
        message,
        detail
      }
    }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // Logs are diagnostic only and should never break the scan.
  }
}

function findVisibleDetailRoot(beforeUrls) {
  const roots = [
    ...document.querySelectorAll("[role='dialog'], [aria-modal='true'], [data-radix-dialog-content], [data-headlessui-state]")
  ].filter(isVisibleElement);

  for (const root of roots) {
    if (hasNewLargeImage(root, beforeUrls) || hasVisibleCandidateImage(root)) {
      return root;
    }
  }

  return null;
}

function hasNewLargeImage(root, beforeUrls) {
  for (const img of root.querySelectorAll("img")) {
    const rect = img.getBoundingClientRect();
    const width = Math.max(img.naturalWidth || 0, rect.width || 0);
    const height = Math.max(img.naturalHeight || 0, rect.height || 0);
    const url = toAbsoluteUrl(img.currentSrc || img.src);

    if (!url || width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE) {
      continue;
    }

    const isNewUrl = !beforeUrls.has(canonicalUrl(url));
    const looksFullSize = width > THUMBNAIL_MAX_DIMENSION
      || height > THUMBNAIL_MAX_DIMENSION
      || width * height >= MIN_ORIGINAL_DIMENSION * MIN_ORIGINAL_DIMENSION;

    if (isNewUrl || looksFullSize) {
      return true;
    }
  }

  return false;
}

function hasVisibleCandidateImage(root) {
  for (const img of root.querySelectorAll("img")) {
    const rect = img.getBoundingClientRect();
    const width = Math.max(img.naturalWidth || 0, rect.width || 0);
    const height = Math.max(img.naturalHeight || 0, rect.height || 0);
    const url = toAbsoluteUrl(img.currentSrc || img.src);

    if (url && !isUiAssetUrl(url) && width >= MIN_IMAGE_SIZE && height >= MIN_IMAGE_SIZE) {
      return true;
    }
  }

  return false;
}

function collectImageUrlCandidates(root) {
  const candidates = [];

  for (const img of root.querySelectorAll("img")) {
    candidates.push(...imageUrlCandidatesFromElement(img, "detail-img"));
  }

  for (const source of root.querySelectorAll("source[srcset]")) {
    const rect = source.parentElement?.getBoundingClientRect?.();
    candidates.push(...srcSetCandidates(source.getAttribute("srcset"), {
      width: rect?.width || 0,
      height: rect?.height || 0,
      source: "detail-source"
    }));
  }

  for (const link of root.querySelectorAll("a[href]")) {
    const href = toAbsoluteUrl(link.href);
    const label = link.textContent || link.getAttribute("aria-label") || "";
    const hasDownloadIntent = link.hasAttribute("download") || /download|下载/i.test(label);
    if (!href || (!isStrongImageUrl(href) && !hasDownloadIntent)) {
      continue;
    }

    candidates.push({
      url: href,
      width: 0,
      height: 0,
      source: "detail-link",
      score: hasDownloadIntent ? 800000 : 400000
    });
  }

  for (const element of root.querySelectorAll("[style]")) {
    const style = element.getAttribute("style") || "";
    for (const match of style.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
      const url = toAbsoluteUrl(match[1]);
      if (!url || !isLikelyImageUrl(url)) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      candidates.push({
        url,
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0),
        source: "detail-style",
        score: Math.round((rect.width || 0) * (rect.height || 0))
      });
    }
  }

  return candidates;
}

function imageUrlCandidatesFromElement(img, source) {
  const rect = img.getBoundingClientRect();
  const width = Math.max(img.naturalWidth || 0, rect.width || 0);
  const height = Math.max(img.naturalHeight || 0, rect.height || 0);
  const candidates = [];

  for (const url of [img.currentSrc, img.src].filter(Boolean)) {
    candidates.push({
      url,
      width,
      height,
      source,
      score: Math.round(width * height)
    });
  }

  candidates.push(...srcSetCandidates(img.getAttribute("srcset"), {
    width,
    height,
    source
  }));

  return candidates;
}

function srcSetCandidates(srcset, base = {}) {
  return String(srcset || "")
    .split(",")
    .map((part) => {
      const [rawUrl, rawDescriptor = ""] = part.trim().split(/\s+/, 2);
      const descriptor = rawDescriptor.trim().toLowerCase();
      const widthDescriptor = descriptor.match(/^(\d+)w$/);
      const densityDescriptor = descriptor.match(/^([\d.]+)x$/);
      const width = widthDescriptor
        ? Number(widthDescriptor[1])
        : Math.round((base.width || 0) * (densityDescriptor ? Number(densityDescriptor[1]) : 1));
      const height = base.height && base.width && width
        ? Math.round((base.height / base.width) * width)
        : base.height || 0;

      return {
        url: rawUrl,
        width,
        height,
        source: base.source || "srcset",
        score: Math.round((width || 0) * (height || 0))
      };
    })
    .filter((candidate) => candidate.url);
}

function chooseBestCandidate(candidates, thumbnailUrl) {
  const thumbnailKey = canonicalUrl(thumbnailUrl || "");
  const unique = new Map();

  for (const candidate of candidates) {
    const absoluteUrl = toAbsoluteUrl(candidate.url);
    if (!absoluteUrl || !isLikelyImageUrl(absoluteUrl) || isUiAssetUrl(absoluteUrl)) {
      continue;
    }

    const originalUrl = normalizeOriginalDownloadUrl(absoluteUrl);
    if (!originalUrl || !isLikelyImageUrl(originalUrl) || isUiAssetUrl(originalUrl)) {
      continue;
    }

    const normalizedFromThumbnail = canonicalUrl(originalUrl) !== canonicalUrl(absoluteUrl);
    const urlSize = sizeHintFromUrl(originalUrl);
    const width = Math.max(candidate.width || 0, urlSize.width || 0);
    const height = Math.max(candidate.height || 0, urlSize.height || 0);
    const key = canonicalUrl(originalUrl);
    const scored = {
      ...candidate,
      url: originalUrl,
      rawUrl: candidate.rawUrl || absoluteUrl,
      width,
      height,
      score: scoreCandidate(originalUrl, {
        ...candidate,
        width,
        height,
        isThumbnail: key === thumbnailKey && !normalizedFromThumbnail,
        normalizedFromThumbnail
      }),
      normalizedFromThumbnail
    };
    const existing = unique.get(key);

    if (!existing || scored.score > existing.score) {
      unique.set(key, scored);
    }
  }

  return Array.from(unique.values()).sort((a, b) => b.score - a.score)[0] || null;
}

function scoreCandidate(url, candidate) {
  let score = Number(candidate.score) || 0;
  const lower = url.toLowerCase();
  const retainableDownloadUrl = isRetainableDownloadCandidateUrl(url);

  score += Math.round((candidate.width || 0) * (candidate.height || 0));

  if (candidate.source === "detail-link") score += 500000;
  if (lower.includes("oaidalleapiprodscus.blob.core.windows.net")) score += 900000;
  if (lower.includes("images.openai.com")) score += 500000;
  if (isEstuaryContentUrl(url)) score += 850000;
  if (retainableDownloadUrl) score += 300000;
  if (candidate.normalizedFromThumbnail) score += 450000;
  if (lower.includes("chatgpt.com")) score += 150000;
  if (candidate.isThumbnail && !retainableDownloadUrl) score -= 750000;
  if (/thumbnail|thumb|preview|small|avatar|icon/.test(lower) && !retainableDownloadUrl) score -= 600000;
  if (IMAGE_URL_RE.test(url)) score += 100000;

  return score;
}

function sizeHintFromUrl(url) {
  try {
    const parsed = new URL(url);
    const width = Number(parsed.searchParams.get("w") || parsed.searchParams.get("width") || 0);
    const height = Number(parsed.searchParams.get("h") || parsed.searchParams.get("height") || 0);
    const pathMatch = parsed.pathname.match(/(\d{3,5})[xX](\d{3,5})/);

    return {
      width: width || Number(pathMatch?.[1] || 0),
      height: height || Number(pathMatch?.[2] || 0)
    };
  } catch {
    return { width: 0, height: 0 };
  }
}

function normalizeOriginalDownloadUrl(url) {
  const absoluteUrl = toAbsoluteUrl(url);
  if (!absoluteUrl) {
    return null;
  }

  return deriveOriginalUrlFromThumbnail(absoluteUrl)
    || removeThumbnailMarkerFromUrl(absoluteUrl)
    || absoluteUrl;
}

function removeThumbnailMarkerFromUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    const id = parsed.searchParams.get("id") || "";
    let changed = false;

    if (/#thumbnail$/i.test(id)) {
      const originalId = id.replace(/#thumbnail$/i, "");
      if (originalId) {
        parsed.searchParams.set("id", originalId);
        changed = true;
      }
    }

    if (/^#thumbnail$/i.test(parsed.hash || "")) {
      parsed.hash = "";
      changed = true;
    }

    return changed ? parsed.href : null;
  } catch {
    return null;
  }
}

function hasThumbnailMarkerInUrl(url) {
  if (!url) {
    return false;
  }

  const info = estuaryContentInfo(url);
  if (info?.hasThumbnailMarker) {
    return true;
  }

  try {
    const parsed = new URL(url, location.href);
    const id = parsed.searchParams.get("id") || "";
    return /#thumbnail$/i.test(id) || /^#thumbnail$/i.test(parsed.hash || "");
  } catch {
    return /#thumbnail(?:$|[/?#&])/i.test(String(url));
  }
}

function sourceUrlLooksLikeThumbnail(url) {
  if (!url) {
    return false;
  }

  if (hasThumbnailMarkerInUrl(url)) {
    return true;
  }

  try {
    const parsed = new URL(url, location.href);
    return /(?:thumbnail|thumb|preview|small)/i.test(`${parsed.pathname} ${parsed.search} ${parsed.hash}`);
  } catch {
    return /(?:thumbnail|thumb|preview|small)/i.test(String(url));
  }
}

function deriveOriginalUrlFromThumbnail(url) {
  try {
    const info = estuaryContentInfo(url);

    if (!info?.isEstuaryContent) {
      return null;
    }

    const parsed = new URL(info.parsed.href);
    const id = info.id;

    if (id && /#thumbnail$/i.test(id)) {
      const originalId = id.replace(/#thumbnail$/i, "");
      if (!originalId || originalId === id) {
        return null;
      }

      parsed.searchParams.set("id", originalId);
      parsed.hash = "";
      return parsed.href;
    }

    if (/^#thumbnail$/i.test(parsed.hash)) {
      parsed.hash = "";
      return parsed.href;
    }

    return isRetainableDownloadCandidateUrl(parsed.href) ? parsed.href : null;
  } catch {
    return null;
  }
}

function shouldKeepCandidateAfterPrecheck(url, check) {
  return check?.status === 403 && isRetainableDownloadCandidateUrl(url);
}

function isRetainableDownloadCandidateUrl(url) {
  const info = estuaryContentInfo(url);
  if (info?.isEstuaryContent) {
    return Boolean(info.id || info.hasSignature || info.hasThumbnailMarker);
  }

  try {
    const parsed = new URL(url, location.href);
    const hostname = parsed.hostname.toLowerCase();
    const trustedImageHost = [
      "oaidalleapiprodscus.blob.core.windows.net",
      "images.openai.com",
      "persistent.oaistatic.com",
      "files.oaiusercontent.com"
    ].some((host) => hostname === host || hostname.endsWith(`.${host}`));

    return trustedImageHost && !isUiAssetUrl(parsed.href) && (
      hasSignatureLikeSearchParam(parsed.searchParams)
      || IMAGE_URL_RE.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function isEstuaryContentUrl(url) {
  return Boolean(estuaryContentInfo(url)?.isEstuaryContent);
}

function estuaryContentInfo(url) {
  try {
    const parsed = new URL(url, location.href);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase().replace(/\/+$/, "");
    const id = parsed.searchParams.get("id") || "";
    const hash = parsed.hash || "";

    return {
      parsed,
      id,
      isEstuaryContent: isChatGptHost(hostname) && ESTUARY_CONTENT_PATHS.has(pathname),
      hasThumbnailMarker: /#thumbnail$/i.test(id) || /^#thumbnail$/i.test(hash),
      hasSignature: hasSignatureLikeSearchParam(parsed.searchParams)
    };
  } catch {
    return null;
  }
}

function hasSignatureLikeSearchParam(searchParams) {
  return [
    "sig",
    "signature",
    "token",
    "se",
    "st",
    "sp",
    "sv",
    "expires",
    "expiry",
    "exp"
  ].some((name) => searchParams.has(name));
}

function isChatGptHost(hostname) {
  const value = String(hostname || "").toLowerCase();
  return value === "chatgpt.com"
    || value.endsWith(".chatgpt.com")
    || value === "chat.openai.com"
    || value.endsWith(".chat.openai.com");
}

function isDirectDownloadCandidateUrl(url) {
  if (!url || isUiAssetUrl(url)) {
    return false;
  }

  if (isRetainableDownloadCandidateUrl(url) || isEstuaryContentUrl(url)) {
    return true;
  }

  try {
    const parsed = new URL(url, location.href);
    const hostname = parsed.hostname.toLowerCase();
    const trustedHost = [
      "oaidalleapiprodscus.blob.core.windows.net",
      "images.openai.com",
      "persistent.oaistatic.com",
      "files.oaiusercontent.com"
    ].some((host) => hostname === host || hostname.endsWith(`.${host}`));

    return trustedHost && (
      IMAGE_URL_RE.test(parsed.pathname)
      || hasSignatureLikeSearchParam(parsed.searchParams)
    );
  } catch {
    return false;
  }
}

function summarizeUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    const info = estuaryContentInfo(parsed.href);
    const id = info?.id || parsed.searchParams.get("id") || "";

    return {
      host: parsed.hostname,
      path: parsed.pathname,
      id: summarizeId(id),
      hasThumbnailMarker: Boolean(info?.hasThumbnailMarker || /#thumbnail$/i.test(id) || hasThumbnailMarkerInUrl(parsed.href)),
      looksLikeThumbnail: sourceUrlLooksLikeThumbnail(parsed.href),
      hasSignature: Boolean(info?.hasSignature || parsed.searchParams.has("sig"))
    };
  } catch {
    return { value: "invalid-url" };
  }
}

function summarizeId(value) {
  if (!value) {
    return "";
  }

  return value
    .split("#")
    .map((part) => maskText(part, 10, 8))
    .join("#");
}

function maskText(value, headLength, tailLength) {
  const text = String(value || "");
  if (text.length <= headLength + tailLength + 3) {
    return text;
  }

  return `${text.slice(0, headLength)}...${text.slice(-tailLength)}`;
}

function currentImageUrlSet() {
  return new Set(
    Array.from(document.images)
      .map((img) => canonicalUrl(img.currentSrc || img.src || ""))
      .filter(Boolean)
  );
}

async function closeDetail(beforeHref) {
  pressEscape();
  await sleep(CLOSE_SETTLE_MS);

  const dialog = document.querySelector("[role='dialog'], [aria-modal='true'], [data-radix-dialog-content]");
  if (dialog && isVisibleElement(dialog)) {
    const closeButton = findCloseButton(dialog);
    if (closeButton) {
      clickElement(closeButton);
      await sleep(CLOSE_SETTLE_MS);
    }
  }

  if (location.href !== beforeHref) {
    history.back();
    await sleep(Math.max(CLOSE_SETTLE_MS, 600));
  }
}

function findCloseButton(root) {
  const buttons = root.querySelectorAll("button, [role='button'], a[href]");

  for (const button of buttons) {
    const label = [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.textContent
    ].filter(Boolean).join(" ");

    if (/close|dismiss|back|关闭|返回/i.test(label)) {
      return button;
    }
  }

  return null;
}

function pressEscape() {
  for (const type of ["keydown", "keyup"]) {
    document.dispatchEvent(new KeyboardEvent(type, {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
      composed: true
    }));
  }
}

function centerPointForElement(element) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect || !rect.width || !rect.height) {
    return null;
  }

  return {
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2)
  };
}

function safeComputedStyle(element) {
  try {
    return element ? window.getComputedStyle(element) : null;
  } catch {
    return null;
  }
}

function clickElement(element, point = null) {
  const rect = element.getBoundingClientRect();
  const center = point || centerPointForElement(element) || {
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2)
  };
  const clientX = center.clientX;
  const clientY = center.clientY;
  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    screenX: Math.round(window.screenX + clientX),
    screenY: Math.round(window.screenY + clientY),
    button: 0,
    view: window
  };

  try {
    element.focus?.({ preventScroll: true });
  } catch {
    try {
      element.focus?.();
    } catch {
      // Focus is best-effort; pointer events below are the primary path.
    }
  }

  for (const type of ["pointerover", "pointerenter", "pointermove", "pointerdown", "pointerup"]) {
    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent(type, {
        ...common,
        buttons: type === "pointerdown" ? 1 : 0,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true
      }));
    } else {
      element.dispatchEvent(new MouseEvent(type, {
        ...common
      }));
    }
  }

  for (const type of ["mouseover", "mouseenter", "mousemove", "mousedown", "mouseup", "click"]) {
    element.dispatchEvent(new MouseEvent(type, {
      ...common,
      buttons: type === "mousedown" ? 1 : 0,
      detail: type === "click" ? 1 : 0
    }));
  }

  try {
    element.click?.();
  } catch {
    // Some elements expose click but reject programmatic calls; dispatched events above are enough.
  }

  for (const key of ["Enter", " "]) {
    for (const type of ["keydown", "keyup"]) {
      element.dispatchEvent(new KeyboardEvent(type, {
        key,
        code: key === " " ? "Space" : key,
        keyCode: key === " " ? 32 : 13,
        which: key === " " ? 32 : 13,
        bubbles: true,
        cancelable: true,
        composed: true
      }));
    }
  }
}

function findClickableTarget(element) {
  let current = element;
  let depth = 0;
  let pointerTarget = null;
  const imageRect = element?.getBoundingClientRect?.();
  const imageArea = Math.max((imageRect?.width || 0) * (imageRect?.height || 0), 1);

  while (current && current !== document.body && depth < 8) {
    if (current.matches?.("a[href], button, [role='button'], [tabindex]") && !current.disabled) {
      return current;
    }

    const style = safeComputedStyle(current);
    const rect = current.getBoundingClientRect?.();
    const area = (rect?.width || 0) * (rect?.height || 0);
    const className = typeof current.className === "string" ? current.className : "";
    if (!pointerTarget
      && (style?.cursor === "pointer" || /cursor-pointer/.test(className))
      && area >= imageArea * 0.8
      && area <= Math.max(imageArea * 8, 600000)) {
      pointerTarget = current;
    }

    current = current.parentElement;
    depth += 1;
  }

  return pointerTarget || element;
}

function toAbsoluteUrl(url) {
  try {
    if (!url || String(url).startsWith("data:") || String(url).startsWith("blob:")) {
      return null;
    }
    return new URL(url, location.href).href;
  } catch {
    return null;
  }
}

function isLikelyImageUrl(url) {
  if (IMAGE_URL_RE.test(url)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    return [
      "oaidalleapiprodscus.blob.core.windows.net",
      "chatgpt.com",
      "images.openai.com",
      "persistent.oaistatic.com",
      "files.oaiusercontent.com",
      "openai.com"
    ].some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function isStrongImageUrl(url) {
  if (IMAGE_URL_RE.test(url)) {
    return true;
  }

  if (isEstuaryContentUrl(url)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    const lowerPath = parsed.pathname.toLowerCase();

    return [
      "oaidalleapiprodscus.blob.core.windows.net",
      "images.openai.com",
      "persistent.oaistatic.com",
      "files.oaiusercontent.com"
    ].some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
      || lowerPath.includes("/backend-api/files/")
      || lowerPath.includes("/files/");
  } catch {
    return false;
  }
}

function isUiAssetUrl(url) {
  const lower = url.toLowerCase();

  if (isChatGptStaticImageAssetUrl(url)) {
    return true;
  }

  return [
    "/apple-touch-icon",
    "/favicon",
    "/icon",
    "avatar",
    "gravatar",
    "logo",
    "sprite"
  ].some((part) => lower.includes(part));
}

function isChatGptStaticImageAssetUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const knownStaticHost = hostname === "persistent.oaistatic.com"
      || hostname.endsWith(".oaistatic.com")
      || isChatGptHost(hostname);

    if (!knownStaticHost) {
      return false;
    }

    return path.startsWith("/images-app/")
      || path.startsWith("/_next/static/")
      || path.startsWith("/static/")
      || path.includes("/assets/");
  } catch {
    return false;
  }
}

function isVisibleElement(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return rect.width > 0
    && rect.height > 0
    && style.visibility !== "hidden"
    && style.display !== "none";
}

function nearestUsefulContext(element) {
  return element?.closest?.("article, main, section, [role='dialog'], [data-testid], li, div") || document.body;
}

function findDate(element, context) {
  const directTime = closestDateFromTimeElement(element) || closestDateFromTimeElement(context);
  if (directTime) {
    return directTime;
  }

  const ariaDate = dateFromAttributes(element) || dateFromAttributes(context);
  if (ariaDate) {
    return ariaDate;
  }

  const textDate = dateFromText(context?.innerText || "");
  return textDate || null;
}

function closestDateFromTimeElement(root) {
  const timeElement = root?.closest?.("time") || root?.querySelector?.("time");
  if (!timeElement) {
    return null;
  }

  return normalizeDate(timeElement.dateTime || timeElement.getAttribute("datetime") || timeElement.textContent);
}

function dateFromAttributes(element) {
  if (!element?.getAttribute) {
    return null;
  }

  for (const attr of ["aria-label", "title", "data-created-at", "data-date", "datetime"]) {
    const value = element.getAttribute(attr);
    const date = normalizeDate(value);
    if (date) {
      return date;
    }
  }

  return null;
}

function dateFromText(text) {
  const value = String(text || "").slice(0, 800);
  const isoMatch = value.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    return normalizeDate(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`);
  }

  const englishMatch = value.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+20\d{2}\b/i);
  if (englishMatch) {
    return normalizeDate(englishMatch[0]);
  }

  const chineseMatch = value.match(/\b(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\b/);
  if (chineseMatch) {
    return normalizeDate(`${chineseMatch[1]}-${chineseMatch[2]}-${chineseMatch[3]}`);
  }

  return null;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim();
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    const parts = normalized.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (!parts) {
      return null;
    }
    return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])).toISOString();
  }

  return date.toISOString();
}

function findPrompt(element, context) {
  const attrs = [
    element?.getAttribute?.("alt"),
    element?.getAttribute?.("aria-label"),
    context?.getAttribute?.("aria-label")
  ].filter(Boolean);

  const attrPrompt = attrs.find((value) => value.length > 8 && !IMAGE_URL_RE.test(value));
  if (attrPrompt) {
    return cleanPrompt(attrPrompt);
  }

  const text = context?.innerText || "";
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12 && line.length <= 220);

  return cleanPrompt(lines[0] || "");
}

function cleanPrompt(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function addCandidate(seen, candidate) {
  const key = canonicalUrl(candidate.url);
  const existing = seen.get(key);

  if (!existing) {
    seen.set(key, candidate);
    return;
  }

  if (!existing.date && candidate.date) {
    existing.date = candidate.date;
  }

  if (!existing.prompt && candidate.prompt) {
    existing.prompt = candidate.prompt;
  }

  if ((candidate.width * candidate.height) > (existing.width * existing.height)) {
    existing.width = candidate.width;
    existing.height = candidate.height;
  }
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function numberOrDefault(value, fallback) {
  if (value === "" || value === null || value === undefined) {
    return fallback;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
