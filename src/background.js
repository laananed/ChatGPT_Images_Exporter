const DEFAULT_FOLDER = "ChatGPT Images";
const JOB_STATUS_KEY = "imageJobStatus";
const JOB_LOGS_KEY = "imageJobLogs";
const MAX_LOG_ENTRIES = 300;
const IMAGE_URL_RE = /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:[?#].*)?$/i;
const ESTUARY_CONTENT_PATHS = new Set([
  "/api/estuary/content",
  "/backend-api/estuary/content"
]);
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

let activeJob = null;
let logWriteChain = Promise.resolve();
let volatileJobLogs = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "START_IMAGE_JOB") {
    startImageJob(message.payload)
      .then((status) => sendResponse({ ok: true, result: status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_IMAGE_JOB_STATUS") {
    getJobStatus()
      .then((status) => sendResponse({ ok: true, result: status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "CANCEL_IMAGE_JOB") {
    cancelImageJob()
      .then((status) => sendResponse({ ok: true, result: status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "IMAGE_JOB_PROGRESS") {
    handleProgressMessage(message.payload, sender);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "IMAGE_JOB_LOG") {
    appendJobLog({ ...message.payload, tabId: sender?.tab?.id })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_IMAGE_JOB_LOGS") {
    getJobLogs()
      .then((logs) => sendResponse({ ok: true, result: logs }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "CLEAR_IMAGE_JOB_LOGS") {
    clearJobLogs()
      .then(() => sendResponse({ ok: true, result: [] }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "DOWNLOAD_IMAGES") {
    downloadImages(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function startImageJob(payload = {}) {
  const current = await getJobStatus();
  if (isActiveStatus(current.status)) {
    return current;
  }

  const tabId = Number(payload.tabId);
  if (!tabId) {
    throw new Error("没有找到可用的 ChatGPT 标签页。");
  }

  const settings = {
    folder: payload.folder || DEFAULT_FOLDER,
    maxScrolls: clamp(numberOrDefault(payload.maxScrolls, 30), 0, 250),
    delayMs: clamp(numberOrDefault(payload.delayMs, 400), 0, 5000)
  };
  const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const status = {
    id: jobId,
    status: "running",
    stage: "collecting",
    message: "正在滚动并收集缩略图...",
    tabId,
    scanned: 0,
    matched: 0,
    detailFailureCount: 0,
    current: 0,
    total: 0,
    downloadStarted: 0,
    downloadFailures: 0,
    startedAt: Date.now(),
    endedAt: null,
    settings
  };

  activeJob = { id: jobId, tabId };
  await saveJobStatus(status);
  await appendJobLog({
    jobId,
    level: "info",
    source: "background",
    stage: "start",
    message: "任务启动",
    detail: {
      tabId,
      maxScrolls: settings.maxScrolls,
      delayMs: settings.delayMs,
      folder: settings.folder
    }
  });
  runImageJob(jobId, tabId, settings);

  return status;
}

async function runImageJob(jobId, tabId, settings) {
  try {
    await ensureContentScript(tabId);
    await appendJobLog({
      jobId,
      level: "info",
      source: "background",
      stage: "scan",
      message: "内容脚本已就绪，开始扫描"
    });

    const scanResponse = await chrome.tabs.sendMessage(tabId, {
      type: "SCAN_CHATGPT_IMAGES",
      payload: {
        jobId,
        maxScrolls: settings.maxScrolls,
        scrollDelayMs: 900,
        detailOpenTimeoutMs: 5000
      }
    });

    if (!scanResponse?.ok) {
      throw new Error(scanResponse?.error || "扫描失败，请刷新 ChatGPT 页面后重试。");
    }

    const { images, scanned, matched, detailFailureCount } = scanResponse.result;
    await appendJobLog({
      jobId,
      level: matched ? "info" : "warn",
      source: "background",
      stage: "scan-complete",
      message: "扫描完成",
      detail: { scanned, matched, detailFailureCount }
    });
    await mergeJobStatus(jobId, {
      status: "downloading",
      stage: "downloading",
      message: `解析到 ${matched} 张原图链接，正在启动下载...`,
      scanned,
      matched,
      detailFailureCount,
      current: matched,
      total: scanned
    });

    const downloadResult = await downloadImages({
      jobId,
      tabId,
      images,
      folder: settings.folder,
      delayMs: settings.delayMs
    });
    await appendJobLog({
      jobId,
      level: downloadResult.failures.length ? "warn" : "info",
      source: "background",
      stage: "download",
      message: "下载任务已提交",
      detail: {
        started: downloadResult.started,
        failures: downloadResult.failures.length
      }
    });

    await mergeJobStatus(jobId, {
      status: "done",
      stage: "done",
      message: `已启动 ${downloadResult.started} 个下载任务。`,
      downloadStarted: downloadResult.started,
      downloadFailures: downloadResult.failures.length,
      endedAt: Date.now()
    });
  } catch (error) {
    await appendJobLog({
      jobId,
      level: "error",
      source: "background",
      stage: "error",
      message: error?.message || String(error)
    });
    await mergeJobStatus(jobId, {
      status: "error",
      stage: "error",
      message: error?.message || String(error),
      endedAt: Date.now()
    });
  } finally {
    if (activeJob?.id === jobId) {
      activeJob = null;
    }
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING_CHATGPT_IMAGE_CONTENT" });
  } catch (error) {
    const message = error?.message || "";
    if (!message.includes("Receiving end does not exist")) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });
  }
}

async function handleProgressMessage(payload = {}, sender) {
  if (!payload.jobId) {
    return;
  }

  const current = await getJobStatus();
  if (current.id !== payload.jobId || current.status === "canceled") {
    return;
  }

  await saveJobStatus({
    ...current,
    status: "running",
    stage: payload.stage || current.stage,
    message: payload.message || current.message,
    tabId: sender?.tab?.id || current.tabId,
    scanned: Number(payload.scanned ?? current.scanned ?? 0),
    matched: Number(payload.matched ?? current.matched ?? 0),
    detailFailureCount: Number(payload.detailFailureCount ?? current.detailFailureCount ?? 0),
    current: Number(payload.current ?? current.current ?? 0),
    total: Number(payload.total ?? current.total ?? 0)
  });
}

async function cancelImageJob() {
  const current = await getJobStatus();
  if (!isActiveStatus(current.status)) {
    return current;
  }

  try {
    if (current.tabId) {
      await chrome.tabs.sendMessage(current.tabId, {
        type: "CANCEL_CHATGPT_IMAGE_JOB",
        payload: { jobId: current.id }
      });
    }
  } catch {
    // The tab may have been closed or refreshed. The persisted status still updates below.
  }

  if (activeJob?.id === current.id) {
    activeJob = null;
  }

  const canceled = {
    ...current,
    status: "canceled",
    stage: "canceled",
    message: "任务已取消。",
    endedAt: Date.now()
  };
  await saveJobStatus(canceled);
  await appendJobLog({
    jobId: current.id,
    level: "warn",
    source: "background",
    stage: "canceled",
    message: "任务已取消"
  });
  return canceled;
}

async function getJobStatus() {
  const result = await chrome.storage.local.get(JOB_STATUS_KEY);
  return result[JOB_STATUS_KEY] || {
    status: "idle",
    stage: "idle",
    message: "",
    scanned: 0,
    matched: 0,
    detailFailureCount: 0,
    current: 0,
    total: 0,
    downloadStarted: 0,
    downloadFailures: 0
  };
}

async function mergeJobStatus(jobId, patch) {
  const current = await getJobStatus();
  if (current.id !== jobId && current.status !== "idle") {
    return current;
  }
  if (current.id === jobId && current.status === "canceled") {
    return current;
  }

  const next = { ...current, ...patch, id: jobId };
  await saveJobStatus(next);
  return next;
}

async function saveJobStatus(status) {
  await chrome.storage.local.set({ [JOB_STATUS_KEY]: status });
  return status;
}

async function getJobLogs() {
  try {
    const result = await chrome.storage.local.get(JOB_LOGS_KEY);
    const logs = Array.isArray(result[JOB_LOGS_KEY]) ? result[JOB_LOGS_KEY] : [];
    volatileJobLogs = logs.slice(-MAX_LOG_ENTRIES);
    return volatileJobLogs;
  } catch {
    return volatileJobLogs;
  }
}

async function clearJobLogs() {
  logWriteChain = logWriteChain
    .catch(() => undefined)
    .then(async () => {
      volatileJobLogs = [];
      await chrome.storage.local.set({ [JOB_LOGS_KEY]: [] });
    });

  await logWriteChain;
}

async function appendJobLog(entry = {}) {
  const normalized = normalizeLogEntry(entry);

  logWriteChain = logWriteChain
    .catch(() => undefined)
    .then(() => appendJobLogUnlocked(normalized));

  await logWriteChain;
}

async function appendJobLogUnlocked(normalized) {
  try {
    const result = await chrome.storage.local.get(JOB_LOGS_KEY);
    const logs = Array.isArray(result[JOB_LOGS_KEY]) ? result[JOB_LOGS_KEY] : volatileJobLogs;
    const next = [...logs, normalized].slice(-MAX_LOG_ENTRIES);

    volatileJobLogs = next;
    await chrome.storage.local.set({ [JOB_LOGS_KEY]: next });
  } catch {
    volatileJobLogs = [...volatileJobLogs, normalized].slice(-MAX_LOG_ENTRIES);
  }
}

function normalizeLogEntry(entry) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: Date.now(),
    level: ["debug", "info", "warn", "error"].includes(entry.level) ? entry.level : "info",
    source: truncateText(entry.source || "unknown", 40),
    jobId: truncateText(entry.jobId || "", 80),
    tabId: entry.tabId || null,
    stage: truncateText(entry.stage || "", 60),
    message: truncateText(entry.message || "", 240),
    detail: sanitizeLogDetail(entry.detail)
  };
}

function sanitizeLogDetail(detail) {
  if (!detail || typeof detail !== "object") {
    return null;
  }

  try {
    const json = JSON.stringify(detail);
    if (json.length <= 1200) {
      return JSON.parse(json);
    }

    return {
      truncated: true,
      value: json.slice(0, 1200)
    };
  } catch {
    return { value: truncateText(String(detail), 1200) };
  }
}

function truncateText(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function isActiveStatus(status) {
  return status === "running" || status === "downloading";
}

async function downloadImages(payload) {
  const images = Array.isArray(payload?.images) ? payload.images : [];
  const folder = sanitizePathSegment(payload?.folder || DEFAULT_FOLDER);
  const delayMs = clamp(Number(payload?.delayMs) || 400, 0, 5000);
  const jobId = payload?.jobId || "";
  const tabId = Number(payload?.tabId || 0);

  let started = 0;
  const failures = [];

  for (const [index, image] of images.entries()) {
    if (!image?.url) {
      continue;
    }

    const itemNumber = index + 1;
    const urlSummary = summarizeDownloadUrl(image.url);
    await appendJobLog({
      jobId,
      level: "info",
      source: "background",
      stage: "download",
      message: "已解析候选 URL",
      detail: {
        index: itemNumber,
        total: images.length,
        url: urlSummary,
        needsBlobPreparation: shouldPrepareImageInContent(image.url)
      }
    });

    try {
      const target = await resolveDownloadTarget({
        tabId,
        jobId,
        image,
        index: itemNumber,
        total: images.length
      });

      if (!target.ok) {
        failures.push({
          url: image.url,
          reason: target.reason,
          status: target.status || 0,
          contentType: target.contentType || "",
          diagnostic: target.diagnostic || null
        });
        await appendJobLog({
          jobId,
          level: "warn",
          source: "background",
          stage: "download",
          message: "下载前取图失败，未提交下载任务",
          detail: {
            index: itemNumber,
            total: images.length,
            reason: target.reason,
            status: target.status || 0,
            contentType: target.contentType || "",
            url: target.urlSummary || urlSummary,
            diagnostic: target.diagnostic || null
          }
        });

        continue;
      }

      const extension = target.extension || extensionFromMimeType(target.mimeType) || guessExtension(image.url);
      const baseName = buildBaseName(image, itemNumber);
      const filename = `${folder}/${baseName}.${extension}`;
      const submitted = await submitImageDownload({
        tabId,
        jobId,
        image,
        target,
        filename,
        index: itemNumber,
        total: images.length
      });

      if (!submitted.ok) {
        failures.push({
          url: image.url,
          reason: submitted.reason
        });
        await appendJobLog({
          jobId,
          level: "warn",
          source: "background",
          stage: "download",
          message: "图片下载任务提交失败",
          detail: {
            index: itemNumber,
            total: images.length,
            reason: submitted.reason,
            url: urlSummary,
            downloadUrlKind: target.downloadUrlKind || "direct"
          }
        });
        continue;
      }

      started += 1;
      await appendJobLog({
        jobId,
        level: "info",
        source: "background",
        stage: "download",
        message: "submit-original-download: browser download task submitted",
        detail: {
          index: itemNumber,
          total: images.length,
          filename,
          downloadId: submitted.downloadId,
          downloadUrlKind: submitted.downloadUrlKind,
          mimeType: target.mimeType || "",
          size: target.size || 0,
          sourceUrl: target.sourceUrl ? summarizeDownloadUrl(target.sourceUrl) : null,
          width: target.width || 0,
          height: target.height || 0,
          fetchMethod: target.fetchMethod || "",
          fallbackSource: target.fallbackSource || ""
        }
      });
      await appendJobLog({
        jobId,
        level: "info",
        source: "background",
        stage: "download",
        message: "已成功提交图片下载任务",
        detail: {
          index: itemNumber,
          total: images.length,
          filename,
          downloadId: submitted.downloadId,
          downloadUrlKind: submitted.downloadUrlKind,
          mimeType: target.mimeType || "",
          size: target.size || 0,
          sourceUrl: target.sourceUrl ? summarizeDownloadUrl(target.sourceUrl) : null,
          width: target.width || 0,
          height: target.height || 0,
          quality: target.quality || null,
          url: urlSummary,
          fetchMethod: target.fetchMethod || "",
          fallbackSource: target.fallbackSource || ""
        }
      });
    } catch (error) {
      const reason = error?.message || String(error);
      failures.push({
        url: image.url,
        reason
      });
      await appendJobLog({
        jobId,
        level: "warn",
        source: "background",
        stage: "download",
        message: "下载任务处理失败",
        detail: {
          index: itemNumber,
          total: images.length,
          reason,
          url: urlSummary
        }
      });
    }

    if (delayMs > 0 && index < images.length - 1) {
      await sleep(delayMs);
    }
  }

  return { started, failures };
}

async function resolveDownloadTarget({ tabId, jobId, image, index, total }) {
  if (shouldPrepareImageInContent(image.url)) {
    return prepareImageInContent({
      tabId,
      jobId,
      image,
      index,
      total
    });
  }

  if (isLikelyRealImageDownloadUrl(image.url)) {
    return {
      ok: true,
      downloadUrl: image.url,
      downloadUrlKind: "direct",
      extension: guessExtension(image.url),
      mimeType: "",
      size: 0,
      urlSummary: summarizeDownloadUrl(image.url)
    };
  }

  return prepareImageInContent({
    tabId,
    jobId,
    image,
    index,
    total
  });
}

async function prepareImageInContent({ tabId, jobId, image, index, total }) {
  if (!tabId) {
    return {
      ok: false,
      reason: "missing-tab-for-fetch",
      urlSummary: summarizeDownloadUrl(image.url)
    };
  }

  const response = await chrome.tabs.sendMessage(tabId, {
    type: "PREPARE_IMAGE_DOWNLOAD",
    payload: {
      jobId,
      image,
      index,
      total
    }
  });

  if (!response?.ok) {
    return {
      ok: false,
      reason: response?.error || "content-prepare-failed",
      urlSummary: summarizeDownloadUrl(image.url)
    };
  }

  return response.result || {
    ok: false,
    reason: "empty-prepare-result",
    urlSummary: summarizeDownloadUrl(image.url)
  };
}

async function submitImageDownload({ tabId, jobId, image, target, filename, index, total }) {
  try {
    const downloadId = await chrome.downloads.download({
      url: target.downloadUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });

    return {
      ok: true,
      downloadId,
      downloadUrlKind: target.downloadUrlKind || "direct"
    };
  } catch (error) {
    if (target.downloadUrlKind !== "blob") {
      return {
        ok: false,
        reason: error?.message || String(error)
      };
    }

    const fallback = await getPreparedImageDataUrl(tabId, target.downloadUrl);
    if (!fallback.ok) {
      return {
        ok: false,
        reason: `${error?.message || String(error)}; data-url-fallback: ${fallback.reason}`
      };
    }

    try {
      const downloadId = await chrome.downloads.download({
        url: fallback.downloadUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });

      await appendJobLog({
        jobId,
        level: "info",
        source: "background",
        stage: "download",
        message: "Blob URL 提交失败，已改用 Data URL 中转提交",
        detail: {
          index,
          total,
          filename,
          downloadId,
          mimeType: fallback.mimeType || target.mimeType || "",
          size: fallback.size || target.size || 0,
          url: summarizeDownloadUrl(image.url)
        }
      });

      return {
        ok: true,
        downloadId,
        downloadUrlKind: "data"
      };
    } catch (fallbackError) {
      return {
        ok: false,
        reason: `${error?.message || String(error)}; data-url-fallback: ${fallbackError?.message || String(fallbackError)}`
      };
    }
  }
}

async function getPreparedImageDataUrl(tabId, downloadUrl) {
  if (!tabId || !downloadUrl) {
    return {
      ok: false,
      reason: "missing-prepared-download"
    };
  }

  const response = await chrome.tabs.sendMessage(tabId, {
    type: "GET_PREPARED_IMAGE_DATA_URL",
    payload: { downloadUrl }
  });

  if (!response?.ok) {
    return {
      ok: false,
      reason: response?.error || "data-url-fallback-failed"
    };
  }

  return response.result || {
    ok: false,
    reason: "empty-data-url-result"
  };
}

function buildBaseName(image, index) {
  const datePrefix = image.date
    ? image.date.slice(0, 10)
    : "unknown-date";
  const title = sanitizePathSegment(image.prompt || image.alt || "chatgpt-image")
    .slice(0, 70)
    .replace(/\s+/g, "-");

  return `${String(index).padStart(4, "0")}-${datePrefix}-${title}`;
}

function guessExtension(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const match = path.match(/\.([a-z0-9]{3,5})$/);

    if (match && ["avif", "bmp", "gif", "jpeg", "jpg", "png", "webp"].includes(match[1])) {
      return match[1] === "jpeg" ? "jpg" : match[1];
    }
  } catch {
    // Fall back below.
  }

  return "png";
}

function shouldPrepareImageInContent(url) {
  return sourceUrlLooksLikeThumbnail(url) || isEstuaryContentUrl(url) || !isLikelyRealImageDownloadUrl(url);
}

function isLikelyRealImageDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const trustedImageHost = [
      "oaidalleapiprodscus.blob.core.windows.net",
      "images.openai.com",
      "persistent.oaistatic.com",
      "files.oaiusercontent.com"
    ].some((host) => hostname === host || hostname.endsWith(`.${host}`));

    if (isEstuaryContentUrl(parsed.href) || sourceUrlLooksLikeThumbnail(parsed.href)) {
      return false;
    }

    return IMAGE_URL_RE.test(parsed.pathname)
      || (trustedImageHost && (
        hasSignatureLikeSearchParam(parsed.searchParams)
      ));
  } catch {
    return false;
  }
}

function isEstuaryContentUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase().replace(/\/+$/, "");
    return isChatGptHost(parsed.hostname) && ESTUARY_CONTENT_PATHS.has(pathname);
  } catch {
    return false;
  }
}

function isChatGptHost(hostname) {
  const value = String(hostname || "").toLowerCase();
  return value === "chatgpt.com"
    || value.endsWith(".chatgpt.com")
    || value === "chat.openai.com"
    || value.endsWith(".chat.openai.com");
}

function extensionFromMimeType(mimeType) {
  return IMAGE_MIME_EXTENSIONS[normalizeMimeType(mimeType)] || "";
}

function normalizeMimeType(value) {
  return String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function hasThumbnailMarkerInUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
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
    const parsed = new URL(url);
    return /(?:thumbnail|thumb|preview|small)/i.test(`${parsed.pathname} ${parsed.search} ${parsed.hash}`);
  } catch {
    return /(?:thumbnail|thumb|preview|small)/i.test(String(url));
  }
}

function summarizeDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get("id") || "";

    return {
      host: parsed.hostname,
      path: parsed.pathname,
      id: summarizeId(id),
      hasThumbnailMarker: hasThumbnailMarkerInUrl(parsed.href),
      looksLikeThumbnail: sourceUrlLooksLikeThumbnail(parsed.href),
      hasSignature: hasSignatureLikeSearchParam(parsed.searchParams)
    };
  } catch {
    return { value: "invalid-url" };
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

function sanitizePathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\.+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 120) || "download";
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
