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
const VOLATILE_IMAGE_KEY_PARAMS = new Set([
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
let detailOpenChain = Promise.resolve();

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
  const parseFailures = [];
  const skippedItems = [];
  const deduplicatedItemSamples = [];
  const collectionStats = createCollectionStats();
  let detailFailureCount = 0;
  let resolvedCardItems = 0;
  let deduplicatedItems = 0;
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

  const cardList = buildSortedCardList(cards);
  const scanList = buildStableScanList(cardList);
  const directOriginals = collectDirectOriginalCandidates(cards, scanList);
  const directResourceSummary = mergeDirectOriginalsIntoScanList(scanList, directOriginals);
  reportLog(jobId, "info", "缩略图收集完成", {
    collected: cardList.length,
    scanListItems: scanList.length,
    checked: collectionStats.checked,
    skippedSmall: collectionStats.skippedSmall,
    skippedNoCandidate: collectionStats.skippedNoCandidate,
    skippedUiAsset: collectionStats.skippedUiAsset,
    skippedSamples: collectionStats.skippedSamples,
    directResources: directResourceSummary
  }, "scan");

  if (!cardList.length && collectionStats.skippedUiAsset) {
    reportLog(jobId, "warn", "只发现 ChatGPT 页面素材，未发现可下载的生成图", {
      hint: "请确认当前标签页已登录，并停留在包含生成图缩略图的 Images 图库或会话页面。",
      skippedUiAsset: collectionStats.skippedUiAsset,
      skippedSamples: collectionStats.skippedSamples
    }, "scan");
  }

  reportLog(jobId, "info", "stable scanList created", {
    total: scanList.length,
    cardItems: cardList.length,
    directResourcesFound: directResourceSummary.found,
    directResourcesMerged: directResourceSummary.merged,
    directResourcesAppended: directResourceSummary.appended,
    items: createScanListReport(scanList).slice(0, 40)
  }, "scan");

  reportProgress(jobId, {
    stage: "resolving",
    message: `Stable scanList ready: ${scanList.length} items. Resolving originals...`,
    scanned: scanList.length,
    total: scanList.length
  });

  for (const [index, scanItem] of scanList.entries()) {
    ensureJobActive(jobId);
    const card = scanItem.card || null;
    const scanIndex = scanItem.scanIndex;
    let original = null;

    if (scanItem.source === "direct-resource") {
      original = scanItem.directOriginal || null;
    } else if (card) {
      original = await resolveOriginalFromCard(card, detailOpenTimeoutMs, jobId, scanIndex);

      if (!original && scanItem.directOriginals.length) {
        original = selectBestDirectOriginal(scanItem.directOriginals);
        if (original) {
          scanItem.resolutionSource = "direct-merged-fallback";
          reportLog(jobId, "info", "merged direct resource used as fallback", {
            scanIndex,
            pageOrder: scanItem.pageOrder,
            imageKey: scanItem.imageKey,
            directSource: original.source || "",
            url: summarizeUrl(original.url)
          }, "resolve");
        }
      }
    }

    if (original) {
      if (scanItem.source !== "direct-resource") {
        resolvedCardItems += 1;
      }

      const image = materializeScanImage(original, scanItem);
      const addResult = addCandidate(originals, image);
      if (addResult.status === "duplicate") {
        deduplicatedItems += 1;
        scanItem.status = "skipped";
        scanItem.reason = "duplicate-original-url";
        if (deduplicatedItemSamples.length < 20) {
          deduplicatedItemSamples.push(createDeduplicatedItem(card, image, scanIndex, scanItem));
        }
        skippedItems.push(createSkippedScanItem(scanItem, "duplicate-original-url", "dedupe", {
          duplicateOfScanIndex: addResult.image?.scanIndex || null,
          originalUrl: summarizeUrl(image.url)
        }));
      } else {
        scanItem.status = "resolved";
        scanItem.reason = "";
        scanItem.resolvedUrl = summarizeUrl(image.url);
      }
    } else {
      detailFailureCount += 1;
      scanItem.status = "parse-failed";
      scanItem.reason = scanItem.reason || "no-download-candidate";
      const failure = createParseFailureItem(card || scanItem, scanIndex, {
        scanIndex,
        pageOrder: scanItem.pageOrder,
        source: scanItem.source,
        imageKey: scanItem.imageKey,
        position: scanItem.position,
        reason: "no-download-candidate",
        stage: "resolve",
        diagnostic: {
          total: scanList.length,
          thumbnail: summarizeUrl(scanItem.thumbnailUrl),
          hasDerivedOriginalUrl: Boolean(card?.derivedOriginalUrl),
          directResourceCount: scanItem.directOriginals.length,
          directResourceDisposition: scanItem.directResourceDisposition || ""
        }
      });
      parseFailures.push(failure);
      reportLog(jobId, "warn", "original resolve failed: no downloadable candidate", {
        scanIndex,
        pageOrder: scanItem.pageOrder,
        source: scanItem.source,
        total: scanList.length,
        imageKey: scanItem.imageKey,
        thumbnail: summarizeUrl(scanItem.thumbnailUrl),
        hasDerivedOriginalUrl: Boolean(card?.derivedOriginalUrl),
        directResourceCount: scanItem.directOriginals.length,
        reason: failure.reason,
        stage: failure.stage,
        diagnostic: failure.diagnostic
      });
    }

    reportProgress(jobId, {
      stage: "resolving",
      message: `Resolving scanList ${index + 1}/${scanList.length}: resolved cards ${resolvedCardItems}, unique originals ${originals.size}, failed ${detailFailureCount}, deduped ${deduplicatedItems}.`,
      scanned: scanList.length,
      matched: originals.size,
      detailFailureCount,
      resolvedCardItems,
      deduplicatedItems,
      current: index + 1,
      total: scanList.length
    });
  }

  const images = Array.from(originals.values())
    .sort((left, right) => numberOrDefault(left.scanIndex, 0) - numberOrDefault(right.scanIndex, 0));
  const scannedCount = scanList.length;
  const scanListReport = createScanListReport(scanList);
  activeScanJobs.delete(jobId);
  reportLog(jobId, images.length ? "info" : "warn", "内容脚本扫描结束", {
    scanned: scannedCount,
    visibleCards: cardList.length,
    scanListItems: scanList.length,
    matched: images.length,
    resolvedCardItems,
    detailFailureCount,
    parseFailures: parseFailures.length,
    deduplicatedItems,
    skippedItems: skippedItems.length,
    directResources: directResourceSummary,
    scanList: scanListReport.slice(0, 40)
  }, "scan");

  return {
    scanned: scannedCount,
    matched: images.length,
    images,
    scanList: scanListReport,
    skippedItems,
    directResourceSummary,
    resolvedCardItems,
    detailFailureCount,
    parseFailures,
    deduplicatedItems,
    deduplicatedItemSamples,
    unknownDateCount: images.filter((image) => !image.date).length
  };
}

function collectImageCards(cards, stats = null) {
  for (const [domOrder, img] of Array.from(document.images).entries()) {
    const card = imageCardFromElement(img, stats, domOrder);
    if (!card) {
      continue;
    }

    const key = canonicalUrl(card.thumbnailUrl);
    const existing = cards.get(key);
    if (!existing) {
      card.collectionOrder = cards.size + 1;
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

    existing.position = chooseEarlierPosition(existing.position, card.position);
  }
}

function buildSortedCardList(cards) {
  const cardList = Array.from(cards.values());
  for (const card of cardList) {
    refreshCardPosition(card);
  }

  return cardList.sort(compareCardsByPageOrder);
}

function refreshCardPosition(card) {
  const element = card?.imageElement || card?.element;
  if (!element?.getBoundingClientRect || !document.contains(element)) {
    return;
  }

  card.position = captureElementPosition(element, card.position?.domOrder ?? card.collectionOrder ?? 0);
}

function buildStableScanList(cardList) {
  return cardList.map((card, index) => {
    const scanIndex = index + 1;
    const pageOrder = index + 1;
    const imageKey = buildFallbackImageKey(card, card, scanIndex);
    const scanItem = {
      scanIndex,
      pageOrder,
      imageKey,
      thumbnailUrl: card.thumbnailUrl || "",
      prompt: card.prompt || card.alt || "",
      date: card.date || "",
      position: normalizePosition(card.position),
      source: "card",
      card,
      directOriginals: [],
      directResourceDisposition: "",
      directSources: [],
      status: "pending",
      reason: ""
    };

    Object.assign(card, {
      scanIndex,
      pageOrder,
      imageKey,
      source: "card",
      position: scanItem.position
    });

    return scanItem;
  });
}

function mergeDirectOriginalsIntoScanList(scanList, directOriginals) {
  const summary = {
    found: directOriginals.length,
    merged: 0,
    appended: 0,
    samples: []
  };

  for (const directOriginal of directOriginals) {
    const scanItem = findScanItemForDirectOriginal(directOriginal, scanList);
    if (scanItem && scanItem.source !== "direct-resource") {
      scanItem.directOriginals.push(directOriginal);
      scanItem.directResourceDisposition = "merged";
      if (directOriginal.source && !scanItem.directSources.includes(directOriginal.source)) {
        scanItem.directSources.push(directOriginal.source);
      }
      summary.merged += 1;
      addDirectResourceSummarySample(summary, directOriginal, scanItem, "merged");
      continue;
    }

    const directItem = createDirectResourceScanItem(directOriginal, scanList.length + 1);
    scanList.push(directItem);
    summary.appended += 1;
    addDirectResourceSummarySample(summary, directOriginal, directItem, "appended");
  }

  return summary;
}

function createDirectResourceScanItem(directOriginal, scanIndex) {
  const pageOrder = scanIndex;
  const imageKey = directOriginal.imageKey || buildDirectResourceImageKey(directOriginal, scanIndex);
  return {
    scanIndex,
    pageOrder,
    imageKey,
    thumbnailUrl: directOriginal.thumbnailUrl || "",
    prompt: directOriginal.prompt || directOriginal.alt || "",
    date: directOriginal.date || "",
    position: normalizePosition(directOriginal.position),
    source: "direct-resource",
    directSource: directOriginal.source || "",
    directOriginal: {
      ...directOriginal,
      scanIndex,
      pageOrder,
      imageKey,
      source: "direct-resource",
      directSource: directOriginal.source || ""
    },
    directOriginals: [],
    directResourceDisposition: "appended",
    directSources: [directOriginal.source || "direct-resource"].filter(Boolean),
    status: "pending",
    reason: ""
  };
}

function findScanItemForDirectOriginal(directOriginal, scanList) {
  if (!directOriginal) {
    return null;
  }

  if (directOriginal.scanIndex) {
    const byScanIndex = scanList.find((item) => item.scanIndex === directOriginal.scanIndex);
    if (byScanIndex) {
      return byScanIndex;
    }
  }

  if (directOriginal.relatedImageKey || directOriginal.imageKey) {
    const imageKey = directOriginal.relatedImageKey || directOriginal.imageKey;
    const byImageKey = scanList.find((item) => item.imageKey === imageKey);
    if (byImageKey) {
      return byImageKey;
    }
  }

  const directUrlKey = canonicalUrl(directOriginal.url || "");
  const thumbnailKey = canonicalUrl(directOriginal.thumbnailUrl || "");
  const byUrl = scanList.find((item) => {
    const card = item.card || {};
    return directUrlKey && (
      directUrlKey === canonicalUrl(item.thumbnailUrl || "")
      || directUrlKey === canonicalUrl(card.thumbnailUrl || "")
      || (card.derivedOriginalUrl && directUrlKey === canonicalUrl(card.derivedOriginalUrl))
    ) || thumbnailKey && thumbnailKey === canonicalUrl(item.thumbnailUrl || "");
  });

  if (byUrl) {
    return byUrl;
  }

  const directPrompt = normalizeMatchText(directOriginal.prompt || directOriginal.alt || "");
  const directDate = String(directOriginal.date || "");
  if (directPrompt || directDate) {
    const textMatches = scanList.filter((item) => {
      const itemPrompt = normalizeMatchText(item.prompt || "");
      const itemDate = String(item.date || "");
      return (directPrompt && itemPrompt && directPrompt === itemPrompt)
        || (directDate && itemDate && directDate === itemDate && directPrompt && itemPrompt.includes(directPrompt.slice(0, 32)));
    });

    if (textMatches.length === 1) {
      return textMatches[0];
    }
  }

  return findNearestScanItemByPosition(directOriginal.position, scanList);
}

function findNearestScanItemByPosition(position, scanList) {
  const normalized = normalizePosition(position);
  if (!Number.isFinite(normalized.top) || !Number.isFinite(normalized.left)) {
    return null;
  }

  let best = null;
  let bestDistance = Infinity;
  for (const item of scanList) {
    if (item.source === "direct-resource") {
      continue;
    }
    const itemPosition = normalizePosition(item.position);
    if (!Number.isFinite(itemPosition.top) || !Number.isFinite(itemPosition.left)) {
      continue;
    }
    const distance = Math.abs(itemPosition.top - normalized.top) + Math.abs(itemPosition.left - normalized.left);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }

  return bestDistance <= 80 ? best : null;
}

function selectBestDirectOriginal(directOriginals) {
  return [...directOriginals].sort((a, b) => directOriginalScore(b) - directOriginalScore(a))[0] || null;
}

function directOriginalScore(original) {
  return Number(original.directCandidateScore || original.score || 0)
    + Math.round((original.width || 0) * (original.height || 0));
}

function materializeScanImage(original, scanItem) {
  const source = scanItem.source === "direct-resource"
    ? "direct-resource"
    : (original.source || scanItem.source || "card");
  const card = scanItem.card || scanItem;
  const imageKey = buildResolvedImageKey(original, card, scanItem.scanIndex);
  scanItem.imageKey = imageKey || scanItem.imageKey;
  if (scanItem.card) {
    scanItem.card.imageKey = scanItem.imageKey;
  }

  return {
    ...original,
    scanIndex: scanItem.scanIndex,
    pageOrder: scanItem.pageOrder,
    imageKey: scanItem.imageKey,
    thumbnailUrl: original.thumbnailUrl || scanItem.thumbnailUrl || "",
    prompt: original.prompt || scanItem.prompt || "",
    date: original.date || scanItem.date || "",
    source,
    directSource: original.directSource || (scanItem.source === "direct-resource" ? scanItem.directSource : original.source || ""),
    resolutionSource: scanItem.resolutionSource || original.source || "",
    position: normalizePosition(scanItem.position),
    directResourceDisposition: scanItem.directResourceDisposition || ""
  };
}

function createScanListReport(scanList) {
  return scanList.map((item) => ({
    scanIndex: item.scanIndex,
    pageOrder: item.pageOrder,
    imageKey: item.imageKey,
    thumbnailUrl: summarizeUrl(item.thumbnailUrl),
    prompt: truncateReportText(item.prompt || "", 240),
    date: truncateReportText(item.date || "", 80),
    position: normalizePosition(item.position),
    source: item.source || "",
    status: item.status || "pending",
    reason: item.reason || "",
    resolvedUrl: item.resolvedUrl || "",
    directResourceDisposition: item.directResourceDisposition || "",
    directSource: item.directSource || "",
    directSources: item.directSources || [],
    directResourceCount: item.source === "direct-resource" ? 1 : (item.directOriginals?.length || 0)
  }));
}

function createSkippedScanItem(scanItem, reason, stage, diagnostic = {}) {
  return {
    index: scanItem.scanIndex,
    scanIndex: scanItem.scanIndex,
    pageOrder: scanItem.pageOrder,
    imageKey: scanItem.imageKey,
    thumbnailUrl: summarizeUrl(scanItem.thumbnailUrl),
    prompt: truncateReportText(scanItem.prompt || "", 240),
    date: truncateReportText(scanItem.date || "", 80),
    source: scanItem.source || "",
    reason,
    stage,
    diagnostic: sanitizeReportDiagnostic({
      position: normalizePosition(scanItem.position),
      directResourceDisposition: scanItem.directResourceDisposition || "",
      directSources: scanItem.directSources || [],
      ...diagnostic
    }, 1000)
  };
}

function addDirectResourceSummarySample(summary, directOriginal, scanItem, disposition) {
  if (summary.samples.length >= 20) {
    return;
  }

  summary.samples.push({
    disposition,
    scanIndex: scanItem.scanIndex,
    pageOrder: scanItem.pageOrder,
    imageKey: scanItem.imageKey,
    source: scanItem.source,
    directSource: directOriginal.source || "",
    url: summarizeUrl(directOriginal.url)
  });
}

function buildDirectResourceImageKey(directOriginal, index) {
  return buildResolvedImageKey(directOriginal, directOriginal, index);
}

function compareCardsByPageOrder(left, right) {
  return comparePosition(left.position, right.position)
    || numberOrDefault(left.collectionOrder, 0) - numberOrDefault(right.collectionOrder, 0)
    || canonicalUrl(left.thumbnailUrl || "").localeCompare(canonicalUrl(right.thumbnailUrl || ""));
}

function chooseEarlierPosition(left, right) {
  if (!left) {
    return normalizePosition(right);
  }
  if (!right) {
    return normalizePosition(left);
  }

  return comparePosition(left, right) <= 0 ? normalizePosition(left) : normalizePosition(right);
}

function comparePosition(left, right) {
  const a = normalizePosition(left);
  const b = normalizePosition(right);
  const topDelta = finiteOrMax(a.top) - finiteOrMax(b.top);
  if (Math.abs(topDelta) > 8) {
    return topDelta;
  }

  const leftDelta = finiteOrMax(a.left) - finiteOrMax(b.left);
  if (Math.abs(leftDelta) > 8) {
    return leftDelta;
  }

  return finiteOrMax(a.domOrder) - finiteOrMax(b.domOrder);
}

function captureElementPosition(element, domOrder = 0, rect = null) {
  const box = rect || element?.getBoundingClientRect?.() || {};
  return normalizePosition({
    top: Math.round((box.top || 0) + window.scrollY),
    left: Math.round((box.left || 0) + window.scrollX),
    width: Math.round(box.width || 0),
    height: Math.round(box.height || 0),
    domOrder
  });
}

function normalizePosition(position = {}) {
  position = position && typeof position === "object" ? position : {};

  return {
    top: finiteNumber(position.top),
    left: finiteNumber(position.left),
    width: finiteNumber(position.width),
    height: finiteNumber(position.height),
    domOrder: finiteNumber(position.domOrder)
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteOrMax(value) {
  if (value === null || value === undefined || value === "") {
    return Number.MAX_SAFE_INTEGER;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

function normalizeMatchText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 120);
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

function imageCardFromElement(img, stats = null, domOrder = 0) {
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
    position: captureElementPosition(img, domOrder, rect),
    source: "card",
    resolved: false
  };
}

async function resolveOriginalFromCard(card, detailOpenTimeoutMs, jobId, index) {
  const derivedOriginal = await originalFromDerivedThumbnail(card, jobId, index);
  if (derivedOriginal) {
    return derivedOriginal;
  }

  return withDetailOpenLock(jobId, index, "resolve", async () => {
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
    return fallbackOriginalFromCard(card, jobId, index, "detail-not-opened", {
      timeoutMs: detailOpenTimeoutMs,
      openAttempts: openResult.attempts,
      clickableTag: card.element?.tagName || ""
    });
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
    return fallbackOriginalFromCard(card, jobId, index, "detail-no-candidate", {
      candidateCount: candidates.length
    });
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
    return fallbackOriginalFromCard(card, jobId, index, "detail-only-thumbnail", {
      candidateCount: candidates.length,
      best: summarizeUrl(best.url),
      bestWidth: best.width || 0,
      bestHeight: best.height || 0
    });
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
    thumbnailUrl: card.thumbnailUrl || "",
    width: Math.round(best.width || card.width || 0),
    height: Math.round(best.height || card.height || 0),
    source: best.source || "detail"
  };
  });
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
    card.derivedOriginalFailure = {
      reason: "derived-original-precheck-403",
      diagnostic: {
        original: summarizeUrl(candidate.url),
        check
      }
    };
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
  card.derivedOriginalFailure = {
    reason: "derived-original-precheck-failed",
    diagnostic: {
      original: summarizeUrl(candidate.url),
      check
    }
  };

  return null;
}

function fallbackOriginalFromCard(card, jobId, index, reason, diagnostic = {}) {
  const candidates = collectFallbackImageUrlCandidates(card);
  const best = chooseBestCandidate(candidates, card.thumbnailUrl);
  const baseDiagnostic = {
    detailReason: reason,
    ...diagnostic,
    derivedOriginalFailure: card.derivedOriginalFailure || null
  };

  if (!best) {
    reportLog(jobId, "warn", "Fallback 解析失败：确实没有可用 URL", {
      index,
      reason,
      candidateCount: candidates.length,
      thumbnail: summarizeUrl(card.thumbnailUrl)
    });
    noteCardParseFailure(card, {
      reason: "fallback-no-candidate",
      stage: "resolve-fallback",
      diagnostic: {
        ...baseDiagnostic,
        candidateCount: candidates.length,
        thumbnail: summarizeUrl(card.thumbnailUrl)
      }
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
    noteCardParseFailure(card, {
      reason: "fallback-only-thumbnail",
      stage: "resolve-fallback",
      diagnostic: {
        ...baseDiagnostic,
        candidateCount: candidates.length,
        thumbnail: summarizeUrl(card.thumbnailUrl),
        best: summarizeUrl(best.url),
        bestWidth: best.width || 0,
        bestHeight: best.height || 0
      }
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
    noteCardParseFailure(card, {
      reason: "unverified-estuary-fallback",
      stage: "resolve-fallback",
      diagnostic: {
        ...baseDiagnostic,
        candidateCount: candidates.length,
        thumbnail: summarizeUrl(card.thumbnailUrl),
        selected: summarizeUrl(best.url),
        source: best.source || ""
      }
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

function collectDirectOriginalCandidates(cards, scanList = []) {
  const rawCandidates = [];
  const cardList = scanList.length
    ? scanList.map((item) => item.card).filter(Boolean)
    : Array.from(cards.values());

  for (const [domOrder, img] of Array.from(document.images).entries()) {
    const relatedCard = cardList.find((card) => card.imageElement === img) || null;
    for (const candidate of imageUrlCandidatesFromElement(img, "direct-img")) {
      addDirectOriginalCandidate(rawCandidates, candidate.url, candidate.source, {
        card: relatedCard,
        width: candidate.width,
        height: candidate.height,
        score: candidate.score,
        position: relatedCard?.position || captureElementPosition(img, domOrder)
      });
    }
  }

  for (const [domOrder, source] of Array.from(document.querySelectorAll("source[srcset]")).entries()) {
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
        score: candidate.score,
        position: source.parentElement ? captureElementPosition(source.parentElement, domOrder, rect) : null
      });
    }
  }

  for (const [domOrder, link] of Array.from(document.querySelectorAll("a[href]")).entries()) {
    addDirectOriginalCandidate(rawCandidates, link.href || link.getAttribute("href"), "direct-link", {
      score: link.hasAttribute("download") ? 850000 : 350000,
      position: captureElementPosition(link, domOrder)
    });
  }

  for (const [domOrder, element] of Array.from(document.querySelectorAll("[style]")).slice(0, 1200).entries()) {
    const style = element.getAttribute("style") || "";
    const rect = element.getBoundingClientRect();

    for (const match of style.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
      addDirectOriginalCandidate(rawCandidates, match[1], "direct-style", {
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0),
        score: Math.round((rect.width || 0) * (rect.height || 0)),
        position: captureElementPosition(element, domOrder, rect)
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
    order: candidates.length + 1,
    card: options.card || null,
    position: normalizePosition(options.position || options.card?.position),
    thumbnailUrl: options.card?.thumbnailUrl || "",
    prompt: options.card?.prompt || "",
    date: options.card?.date || ""
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
    .sort(compareDirectCandidates)
    .map((candidate) => {
      const card = candidate.card || findRelatedCardForCandidate(candidate.url, cards) || {
        date: null,
        prompt: "",
        alt: "",
        thumbnailUrl: candidate.thumbnailUrl || "",
        position: candidate.position,
        width: candidate.width || 0,
        height: candidate.height || 0
      };

      const result = imageResultFromCandidate(candidate, card);
      return {
        ...result,
        scanIndex: card.scanIndex || 0,
        pageOrder: card.pageOrder || 0,
        imageKey: result.imageKey || card.imageKey || "",
        relatedImageKey: card.imageKey || "",
        position: normalizePosition(card.position || candidate.position),
        directCandidateOrder: candidate.order || 0,
        directCandidateScore: directCandidateScore(candidate)
      };
    });
}

function compareDirectCandidates(left, right) {
  const leftCardOrder = left.card?.pageOrder || Number.MAX_SAFE_INTEGER;
  const rightCardOrder = right.card?.pageOrder || Number.MAX_SAFE_INTEGER;
  if (leftCardOrder !== rightCardOrder) {
    return leftCardOrder - rightCardOrder;
  }

  const positionCompare = comparePosition(left.position, right.position);
  if (positionCompare) {
    return positionCompare;
  }

  return numberOrDefault(left.order, 0) - numberOrDefault(right.order, 0)
    || directCandidateScore(right) - directCandidateScore(left);
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
  const result = {
    url: candidate.url,
    date: card.date,
    prompt: card.prompt,
    alt: card.alt,
    thumbnailUrl: card.thumbnailUrl || "",
    width: Math.round(candidate.width || card.width || 0),
    height: Math.round(candidate.height || card.height || 0),
    source: candidate.source || "",
    directSource: candidate.source || "",
    position: normalizePosition(candidate.position || card.position)
  };
  result.imageKey = buildResolvedImageKey(result, card, card.scanIndex || candidate.order || 0);
  result.normalizedOriginalUrl = normalizedOriginalUrlForKey(result.url);

  return result;
}

function noteCardParseFailure(card, failure) {
  if (!card || card.resolveFailure) {
    return;
  }

  card.resolveFailure = failure;
}

function createParseFailureItem(card, index, fallback = {}) {
  const failure = card.resolveFailure || fallback || {};
  const diagnostic = {
    ...(fallback.diagnostic && typeof fallback.diagnostic === "object" ? fallback.diagnostic : {}),
    ...(failure.diagnostic && typeof failure.diagnostic === "object" ? failure.diagnostic : {})
  };
  const reason = truncateReportText(failure.reason || fallback.reason || "unknown-parse-failure", 160);
  const scanIndex = Number(fallback.scanIndex || card.scanIndex || index || 0);

  return {
    index: scanIndex || index,
    scanIndex: scanIndex || index,
    pageOrder: Number(fallback.pageOrder || card.pageOrder || scanIndex || index || 0),
    imageKey: failure.imageKey || fallback.imageKey || buildParseFailureImageKey(card, index),
    thumbnailUrl: summarizeUrl(card.thumbnailUrl),
    prompt: truncateReportText(card.prompt || card.alt || "", 240),
    date: truncateReportText(card.date || "", 80),
    source: truncateReportText(fallback.source || card.source || "", 80),
    reason,
    stage: truncateReportText(failure.stage || fallback.stage || "resolve", 80),
    diagnostic: sanitizeReportDiagnostic({
      cardWidth: card.width || 0,
      cardHeight: card.height || 0,
      hasDerivedOriginalUrl: Boolean(card.derivedOriginalUrl),
      position: normalizePosition(fallback.position || card.position),
      ...diagnostic
    }),
    quality: normalizePreparedQuality(failure.quality || fallback.quality || diagnostic.quality, {
      width: 0,
      height: 0,
      size: 0,
      mimeType: "",
      isOriginalLikely: false,
      rejectReason: reason
    })
  };
}

function createDeduplicatedItem(card, original, index, scanItem = null) {
  return {
    index,
    scanIndex: scanItem?.scanIndex || original.scanIndex || index,
    pageOrder: scanItem?.pageOrder || original.pageOrder || index,
    imageKey: scanItem?.imageKey || original.imageKey || buildResolvedImageKey(original, card, index),
    thumbnailUrl: summarizeUrl(scanItem?.thumbnailUrl || card?.thumbnailUrl || original.thumbnailUrl),
    prompt: truncateReportText(scanItem?.prompt || card?.prompt || original.prompt || card?.alt || "", 240),
    date: truncateReportText(scanItem?.date || card?.date || original.date || "", 80),
    source: scanItem?.source || original.source || "",
    reason: "duplicate-original-url",
    stage: "dedupe",
    diagnostic: sanitizeReportDiagnostic({
      originalUrl: summarizeUrl(original.url),
      cardWidth: card?.width || 0,
      cardHeight: card?.height || 0,
      position: normalizePosition(scanItem?.position || card?.position)
    }, 1000)
  };
}

function buildParseFailureImageKey(card, index) {
  return buildFallbackImageKey(card, card, index);
}

function buildResolvedImageKey(original, card, index) {
  const stableId = stableImageIdFromCandidate(original, card);
  if (stableId) {
    return `img-${shortHashText(stableId, 16)}`;
  }

  const normalizedOriginalUrl = normalizedOriginalUrlForKey(
    original?.url || original?.sourceUrl || original?.originalUrl || original?.downloadUrl || ""
  );
  if (normalizedOriginalUrl) {
    return `img-${shortHashText(`url:${normalizedOriginalUrl}`, 16)}`;
  }

  return buildFallbackImageKey(original, card, index);
}

function buildFallbackImageKey(candidate, card, index) {
  const keyInput = [
    normalizeKeyText(candidate?.prompt || card?.prompt || card?.alt || ""),
    normalizeKeyText(candidate?.date || card?.date || ""),
    canonicalUrl(candidate?.thumbnailUrl || card?.thumbnailUrl || "")
  ].filter(Boolean).join("|") || `image-${index || 0}`;

  return `img-${shortHashText(`fallback:${keyInput}`, 16)}`;
}

function stableImageIdFromCandidate(candidate = {}, card = {}) {
  const explicitIds = [
    candidate.estuaryId,
    candidate.fileId,
    candidate.fileID,
    candidate.file_id,
    card.estuaryId,
    card.fileId,
    card.fileID,
    card.file_id
  ];
  for (const value of explicitIds) {
    const id = normalizeStableImageId(value);
    if (id) {
      return id;
    }
  }

  const urls = [
    candidate.url,
    candidate.rawUrl,
    candidate.sourceUrl,
    candidate.originalUrl,
    candidate.downloadUrl,
    card.derivedOriginalUrl,
    card.thumbnailUrl,
    candidate.thumbnailUrl
  ];
  for (const url of urls) {
    const id = stableImageIdFromUrl(url);
    if (id) {
      return id;
    }
  }

  return "";
}

function stableImageIdFromUrl(url) {
  const estuaryId = normalizedEstuaryContentId(url);
  if (estuaryId) {
    return `estuary:${estuaryId}`;
  }

  const fileId = normalizedFileId(url);
  return fileId ? `file:${fileId}` : "";
}

function normalizeStableImageId(value) {
  const text = String(value || "").trim().replace(/#thumbnail$/i, "");
  if (!text) {
    return "";
  }

  const fileMatch = text.match(/\bfile[-_][A-Za-z0-9_-]{8,}\b/);
  if (fileMatch) {
    return `file:${fileMatch[0]}`;
  }

  return `estuary:${text}`;
}

function normalizedFileId(url) {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url, location.href);
    const paramNames = ["file_id", "fileId", "file", "id"];
    for (const name of paramNames) {
      const value = parsed.searchParams.get(name) || "";
      const match = value.match(/\bfile[-_][A-Za-z0-9_-]{8,}\b/);
      if (match) {
        return match[0];
      }
    }

    const decoded = decodeURIComponent(`${parsed.pathname} ${parsed.search}`);
    const match = decoded.match(/\bfile[-_][A-Za-z0-9_-]{8,}\b/);
    return match ? match[0] : "";
  } catch {
    const match = String(url).match(/\bfile[-_][A-Za-z0-9_-]{8,}\b/);
    return match ? match[0] : "";
  }
}

function normalizedOriginalUrlForKey(url) {
  const absoluteUrl = toAbsoluteUrl(url);
  if (!absoluteUrl || isUiAssetUrl(absoluteUrl)) {
    return "";
  }

  const originalUrl = normalizeOriginalDownloadUrl(absoluteUrl) || absoluteUrl;
  if (!originalUrl || isUiAssetUrl(originalUrl)) {
    return "";
  }

  if (sourceUrlLooksLikeThumbnail(originalUrl) && !deriveOriginalUrlFromThumbnail(originalUrl)) {
    return "";
  }

  return canonicalizeImageUrlForKey(originalUrl);
}

function canonicalizeImageUrlForKey(url) {
  try {
    const parsed = new URL(url, location.href);

    for (const key of Array.from(parsed.searchParams.keys())) {
      const lowerKey = key.toLowerCase();
      if (
        VOLATILE_IMAGE_KEY_PARAMS.has(lowerKey)
        || lowerKey.startsWith("x-ms-")
        || lowerKey.startsWith("x-amz-")
      ) {
        parsed.searchParams.delete(key);
      }
    }

    const params = Array.from(parsed.searchParams.entries())
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        const keyCompare = leftKey.localeCompare(rightKey);
        return keyCompare || leftValue.localeCompare(rightValue);
      });
    const search = params.length
      ? `?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`
      : "";
    const hash = /^#?thumbnail$/i.test(parsed.hash || "") ? "" : parsed.hash;

    return `${parsed.origin}${parsed.pathname}${search}${hash}`;
  } catch {
    return normalizeKeyText(url);
  }
}

function sanitizeReportDiagnostic(value, maxLength = 2000) {
  if (!value || typeof value !== "object") {
    return value ? truncateReportText(value, maxLength) : null;
  }

  try {
    const json = JSON.stringify(value);
    if (json.length <= maxLength) {
      return JSON.parse(json);
    }

    return {
      truncated: true,
      value: json.slice(0, maxLength)
    };
  } catch {
    return { value: truncateReportText(String(value), maxLength) };
  }
}

function truncateReportText(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
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
      reportLog(jobId, "info", "direct-quality-accepted: skipping detail view fallback", {
        ...detailBase,
        quality: prepared.quality || null,
        sourceUrl: prepared.sourceUrl ? summarizeUrl(prepared.sourceUrl) : null,
        downloadUrlKind: prepared.downloadUrlKind || "blob"
      }, "download-prepare");
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
  if (shouldTryDetailFallbackForPreparedImage(fetchResult, detailBase)) {
    reportLog(jobId, "warn", "direct candidate did not pass original-quality gate; opening detail view for recovery", {
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
    quality: fallbackResult.qualityFailure || detailFallbackResult?.qualityFailure || fetchResult.qualityFailure || null,
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

  return withDetailOpenLock(jobId, detailBase.index, "download-prepare", async () => {
  const beforeHref = location.href;
  const beforeUrls = currentImageUrlSet();

  reportLog(jobId, "info", "open-detail-view: opening image detail to recover original", {
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
  });
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
    qualityFailure: firstQualityFailureDetail(failures),
    failures: failures.slice(0, 8),
    locationsTried: Array.from(new Set(locationsTried))
  };
}

function firstQualityFailureDetail(failures = []) {
  for (const failure of failures) {
    const quality = failure?.quality || failure?.diagnostic?.quality || failure?.diagnostic;
    if (quality && typeof quality === "object" && (
      Object.prototype.hasOwnProperty.call(quality, "isOriginalLikely")
      || Object.prototype.hasOwnProperty.call(quality, "rejectReason")
      || Object.prototype.hasOwnProperty.call(quality, "width")
    )) {
      return quality;
    }
  }

  return null;
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
    qualityFailure: firstQualityFailureDetail(failures),
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
  const quality = normalizePreparedQuality(detail?.quality || detail?.validation, {
    width: detail?.width || 0,
    height: detail?.height || 0,
    size: detail?.size || 0,
    mimeType: detail?.mimeType || detail?.contentType || "",
    isOriginalLikely: false,
    rejectReason: reason || "prepare-failed"
  });
  const result = {
    ok: false,
    reason,
    status: detail?.status || 0,
    contentType: detail?.contentType || "",
    urlSummary: detail?.url || null,
    diagnostic: detail?.validation || detail || null,
    quality
  };

  if (reason === "thumbnail-only" || reason === "low-resolution") {
    reportLog(jobId, "warn", reason === "thumbnail-only"
      ? "thumbnail-only: refused to save thumbnail as original"
      : "low-resolution: fallback image dimensions or blob size are insufficient", detail, "download-prepare");
  }

  reportLog(jobId, "warn", "下载前取图失败，未提交下载任务", detail, "download-prepare");
  return result;
}

function normalizePreparedQuality(value = {}, fallback = {}) {
  return {
    ...(value && typeof value === "object" ? value : {}),
    width: Number(value?.width ?? fallback.width ?? 0) || 0,
    height: Number(value?.height ?? fallback.height ?? 0) || 0,
    size: Number(value?.size ?? fallback.size ?? 0) || 0,
    mimeType: String(value?.mimeType || fallback.mimeType || ""),
    isOriginalLikely: value?.isOriginalLikely === true,
    rejectReason: String(value?.rejectReason || fallback.rejectReason || "not-checked")
  };
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
  const size = Number(blob?.size || 0);
  const mimeType = normalizeMimeType(context.mimeType || blob?.type || context.contentType || "");
  const sourceUrl = context.sourceUrl || "";
  const fetchMethod = context.fetchMethod || context.method || "";
  const fallbackSource = context.fallbackSource || "";
  const sourceHasThumbnailMarker = hasThumbnailMarkerInUrl(sourceUrl);
  const sourceLooksLikeThumbnail = sourceUrlLooksLikeThumbnail(sourceUrl);
  const isCanvasFallback = /canvas/i.test(fetchMethod);
  const missingDimensions = !width || !height;
  const is512Thumbnail = Boolean(width && height && width <= THUMBNAIL_MAX_DIMENSION && height <= THUMBNAIL_MAX_DIMENSION);
  const dimensionTooSmall = Boolean(width && height && (width < MIN_ORIGINAL_DIMENSION || height < MIN_ORIGINAL_DIMENSION));
  const lowResolutionArea = Boolean(width && height && width * height < MIN_ORIGINAL_DIMENSION * MIN_ORIGINAL_DIMENSION);
  const smallBlob = Boolean(size < MIN_ORIGINAL_BLOB_SIZE_BYTES);
  const detail = {
    sourceUrl: sourceUrl ? summarizeUrl(sourceUrl) : null,
    sourceHasThumbnailMarker,
    sourceLooksLikeThumbnail,
    width,
    height,
    naturalWidth: width,
    naturalHeight: height,
    size,
    mimeType,
    minExpectedDimension: MIN_ORIGINAL_DIMENSION,
    minExpectedBlobSize: MIN_ORIGINAL_BLOB_SIZE_BYTES,
    fetchMethod,
    fallbackSource,
    isCanvasFallback,
    missingDimensions,
    is512Thumbnail,
    dimensionTooSmall,
    lowResolutionArea,
    smallBlob,
    isOriginalLikely: false,
    rejectReason: "",
    dimensionDecodeError: dimensions.error || ""
  };

  if (sourceHasThumbnailMarker || sourceLooksLikeThumbnail || is512Thumbnail) {
    const rejectReason = sourceHasThumbnailMarker || sourceLooksLikeThumbnail
      ? "source-url-looks-like-thumbnail"
      : "natural-size-at-or-below-512";

    return {
      ok: false,
      reason: "thumbnail-only",
      detail: {
        ...detail,
        rejected: true,
        isOriginalLikely: false,
        rejectReason,
        rejection: rejectReason
      }
    };
  }

  if (missingDimensions || dimensionTooSmall || lowResolutionArea || smallBlob) {
    const rejectReason = missingDimensions
      ? "dimension-unavailable"
      : dimensionTooSmall || lowResolutionArea
        ? "dimensions-too-small"
        : "blob-size-too-small";

    return {
      ok: false,
      reason: "low-resolution",
      detail: {
        ...detail,
        rejected: true,
        isOriginalLikely: false,
        rejectReason,
        rejection: rejectReason
      }
    };
  }

  return {
    ok: true,
    reason: "",
    detail: {
      ...detail,
      rejected: false,
      isOriginalLikely: true,
      rejectReason: ""
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

function shouldTryDetailFallbackForPreparedImage(attempt = {}, detailBase = {}) {
  const reason = String(attempt.reason || "").toLowerCase();
  const quality = attempt.qualityFailure?.quality || attempt.qualityFailure || null;
  const rejectReason = String(quality?.rejectReason || quality?.rejection || "").toLowerCase();

  return attempt.status === 403
    || detailBase.normalizedFromThumbnail
    || Boolean(detailBase.urlIntegrity?.hasThumbnailMarker)
    || Boolean(detailBase.url?.looksLikeThumbnail || detailBase.requestedUrl?.looksLikeThumbnail)
    || ["thumbnail-only", "low-resolution", "missing-quality-result"].includes(reason)
    || Boolean(quality?.isOriginalLikely === false && (
      rejectReason.includes("thumbnail")
      || rejectReason.includes("dimension")
      || rejectReason.includes("blob")
      || rejectReason.includes("small")
      || rejectReason.includes("quality")
    ));
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
      - (rawLooksLikeThumbnail && !normalizedFromThumbnail ? 900000 : 0);
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
  const normalizedFromThumbnail = Boolean(candidate.normalizedFromThumbnail && canonicalUrl(rawUrl) !== canonicalUrl(url));
  const hasMarker = hasThumbnailMarkerInUrl(url)
    || (!normalizedFromThumbnail && hasThumbnailMarkerInUrl(rawUrl));
  const looksLikeThumbnail = sourceUrlLooksLikeThumbnail(url)
    || (!normalizedFromThumbnail && (
      candidate.rawLooksLikeThumbnail
      || sourceUrlLooksLikeThumbnail(rawUrl)
    ));
  const is512Thumbnail = Boolean(width && height && width <= THUMBNAIL_MAX_DIMENSION && height <= THUMBNAIL_MAX_DIMENSION);

  if (!hasMarker && !looksLikeThumbnail && (!is512Thumbnail || normalizedFromThumbnail)) {
    return null;
  }

  const rejection = hasMarker || looksLikeThumbnail
    ? "source-url-looks-like-thumbnail"
    : "natural-size-at-or-below-512";

  return {
    source: candidate.source || "",
    reason: "thumbnail-only",
    url: summarizeUrl(url),
    rawUrl: rawUrl && rawUrl !== url ? summarizeUrl(rawUrl) : null,
    hasThumbnailMarker: hasMarker,
    looksLikeThumbnail,
    naturalWidth: width,
    naturalHeight: height,
    rejection,
    quality: normalizePreparedQuality(null, {
      width,
      height,
      size: 0,
      mimeType: "",
      isOriginalLikely: false,
      rejectReason: rejection
    })
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

async function withDetailOpenLock(jobId, index, stage, task) {
  const previous = detailOpenChain.catch(() => undefined);
  let release = () => undefined;
  detailOpenChain = previous.then(() => new Promise((resolve) => {
    release = resolve;
  }));

  await previous;
  reportLog(jobId || "", "debug", "detail-open-lock-acquired", {
    index: index || 0
  }, stage || "resolve");

  try {
    return await task();
  } finally {
    release();
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
    const rawLooksLikeThumbnail = hasThumbnailMarkerInUrl(absoluteUrl) || sourceUrlLooksLikeThumbnail(absoluteUrl);
    const urlLooksLikeThumbnail = hasThumbnailMarkerInUrl(originalUrl) || sourceUrlLooksLikeThumbnail(originalUrl);
    const urlSize = sizeHintFromUrl(originalUrl);
    const width = Math.max(candidate.width || 0, urlSize.width || 0);
    const height = Math.max(candidate.height || 0, urlSize.height || 0);
    const is512Thumbnail = Boolean(width && height && width <= THUMBNAIL_MAX_DIMENSION && height <= THUMBNAIL_MAX_DIMENSION);
    const dimensionTooSmall = Boolean(width && height && (width < MIN_ORIGINAL_DIMENSION || height < MIN_ORIGINAL_DIMENSION));
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
        normalizedFromThumbnail,
        rawLooksLikeThumbnail,
        urlLooksLikeThumbnail,
        is512Thumbnail,
        dimensionTooSmall
      }),
      normalizedFromThumbnail,
      rawLooksLikeThumbnail,
      urlLooksLikeThumbnail,
      is512Thumbnail,
      dimensionTooSmall
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
  if ((candidate.urlLooksLikeThumbnail || /thumbnail|thumb|preview|small|avatar|icon/.test(lower)) && !retainableDownloadUrl) {
    score -= 900000;
  }
  if (candidate.rawLooksLikeThumbnail && !candidate.normalizedFromThumbnail) {
    score -= 900000;
  }
  if (candidate.is512Thumbnail && !candidate.normalizedFromThumbnail) {
    score -= 800000;
  }
  if (candidate.dimensionTooSmall && !candidate.normalizedFromThumbnail) {
    score -= 250000;
  }
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

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^(?:thumbnail|thumb|preview|small)$/i.test(key)) {
        parsed.searchParams.delete(key);
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
  if (!candidate?.url) {
    return { status: "invalid", image: null };
  }

  const candidateWithKey = candidate.imageKey
    ? candidate
    : {
      ...candidate,
      imageKey: buildResolvedImageKey(candidate, candidate, candidate.scanIndex || candidate.pageOrder || seen.size + 1)
    };
  const key = candidateWithKey.imageKey || canonicalUrl(candidateWithKey.url);
  const existing = seen.get(key);

  if (!existing) {
    seen.set(key, candidateWithKey);
    return { status: "added", image: candidateWithKey };
  }

  if (!existing.date && candidateWithKey.date) {
    existing.date = candidateWithKey.date;
  }

  if (!existing.prompt && candidateWithKey.prompt) {
    existing.prompt = candidateWithKey.prompt;
  }

  if (!existing.thumbnailUrl && candidateWithKey.thumbnailUrl) {
    existing.thumbnailUrl = candidateWithKey.thumbnailUrl;
  }

  if ((candidateWithKey.width * candidateWithKey.height) > (existing.width * existing.height)) {
    existing.width = candidateWithKey.width;
    existing.height = candidateWithKey.height;
  }

  if (!existing.scanIndex && candidateWithKey.scanIndex) {
    existing.scanIndex = candidateWithKey.scanIndex;
  }

  if (!existing.pageOrder && candidateWithKey.pageOrder) {
    existing.pageOrder = candidateWithKey.pageOrder;
  }

  if (!existing.imageKey && candidateWithKey.imageKey) {
    existing.imageKey = candidateWithKey.imageKey;
  }

  if (!existing.source && candidateWithKey.source) {
    existing.source = candidateWithKey.source;
  }

  if (!existing.position && candidateWithKey.position) {
    existing.position = candidateWithKey.position;
  }

  return { status: "duplicate", image: existing };
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    parsed.hash = "";
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lowerKey = key.toLowerCase();
      if (
        VOLATILE_IMAGE_KEY_PARAMS.has(lowerKey)
        || lowerKey.startsWith("x-ms-")
        || lowerKey.startsWith("x-amz-")
      ) {
        parsed.searchParams.delete(key);
      }
    }

    const params = Array.from(parsed.searchParams.entries())
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        const keyCompare = leftKey.localeCompare(rightKey);
        return keyCompare || leftValue.localeCompare(rightValue);
      });
    const search = params.length
      ? `?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`
      : "";

    return `${parsed.origin}${parsed.pathname}${search}`;
  } catch {
    return normalizeKeyText(url);
  }
}

function normalizeKeyText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function shortHashText(value, length = 8) {
  const text = String(value || "");
  const first = fnv1a(text, 0x811c9dc5);
  const second = fnv1a(`${text.length}:${text}`, 0x01000193);

  return `${toPaddedHex(first)}${toPaddedHex(second)}`.slice(0, length);
}

function fnv1a(text, seed) {
  let hash = seed >>> 0;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash >>> 0;
}

function toPaddedHex(value) {
  return (value >>> 0).toString(16).padStart(8, "0");
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
