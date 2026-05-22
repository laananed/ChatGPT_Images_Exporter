const DEFAULT_FOLDER = "ChatGPT Images";
const DEFAULT_ACCOUNT_LABEL = "default";
const DEFAULT_PROMPT_NAME = "chatgpt-image";
const JOB_STATUS_KEY = "imageJobStatus";
const JOB_LOGS_KEY = "imageJobLogs";
const JOB_REPORT_KEY = "jobReport";
const JOB_MANIFEST_KEY = "jobManifest";
const MAX_LOG_ENTRIES = 300;
const IMAGE_URL_RE = /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:[?#].*)?$/i;
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

  const startedAt = Date.now();
  const jobId = `${startedAt}-${Math.random().toString(16).slice(2)}`;
  const settings = {
    folder: sanitizePathSegment(payload.folder || DEFAULT_FOLDER, DEFAULT_FOLDER),
    accountLabel: normalizeAccountLabel(payload.accountLabel),
    maxScrolls: clamp(numberOrDefault(payload.maxScrolls, 30), 0, 250),
    delayMs: clamp(numberOrDefault(payload.delayMs, 400), 0, 5000),
    startedAt
  };
  const runContext = buildRunContext({
    folder: settings.folder,
    accountLabel: settings.accountLabel,
    startedAt,
    jobId
  });
  settings.runId = runContext.runId;
  settings.runFolder = runContext.runFolder;
  const status = {
    id: jobId,
    runId: runContext.runId,
    runFolder: runContext.runFolder,
    status: "running",
    stage: "collecting",
    message: "正在滚动并收集缩略图...",
    tabId,
    scanned: 0,
    matched: 0,
    detailFailureCount: 0,
    scannedItems: 0,
    resolvedCardItems: 0,
    resolvedItems: 0,
    parseFailureCount: 0,
    deduplicatedItems: 0,
    current: 0,
    total: 0,
    downloadStarted: 0,
    submittedDownloads: 0,
    scanListItems: 0,
    skippedItems: 0,
    directResourceSummary: null,
    qualityFailures: 0,
    qualityFailureCount: 0,
    downloadFailures: 0,
    downloadFailureCount: 0,
    startedAt,
    endedAt: null,
    settings
  };

  activeJob = { id: jobId, tabId };
  await saveJobStatus(status);
  await saveJobReport(createJobReport({
    jobId,
    runFolder: runContext.runFolder,
    startedAt,
    scannedItems: 0,
    resolvedCardItems: 0,
    resolvedItems: 0,
    submittedDownloads: 0,
    parseFailures: [],
    qualityFailures: [],
    deduplicatedItems: 0,
    deduplicatedItemSamples: [],
    scanList: [],
    skippedItems: [],
    directResourceSummary: null,
    downloadFailures: []
  }));
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
      folder: settings.folder,
      accountLabel: settings.accountLabel,
      runId: settings.runId,
      runFolder: settings.runFolder
    }
  });
  runImageJob(jobId, tabId, settings);

  return status;
}

async function runImageJob(jobId, tabId, settings) {
  let scannedItems = 0;
  let resolvedCardItems = 0;
  let resolvedItems = 0;
  let deduplicatedItems = 0;
  let deduplicatedItemSamples = [];
  let submittedDownloads = 0;
  let parseFailures = [];
  let qualityFailures = [];
  let downloadFailures = [];
  let scanList = [];
  let skippedItems = [];
  let directResourceSummary = null;

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
    parseFailures = normalizeFailureItems(scanResponse.result?.parseFailures, "resolve");
    scannedItems = Number(scanned || 0);
    resolvedItems = Number(matched || 0);
    resolvedCardItems = Number(scanResponse.result?.resolvedCardItems ?? Math.max(scannedItems - parseFailures.length, resolvedItems));
    deduplicatedItems = Number(scanResponse.result?.deduplicatedItems ?? Math.max(resolvedCardItems - resolvedItems, 0));
    deduplicatedItemSamples = normalizeFailureItems(scanResponse.result?.deduplicatedItemSamples, "dedupe");
    scanList = normalizeScanListItems(scanResponse.result?.scanList);
    skippedItems = normalizeFailureItems(scanResponse.result?.skippedItems, "skip");
    directResourceSummary = sanitizeReportDiagnostic(scanResponse.result?.directResourceSummary, 3000);
    await appendJobLog({
      jobId,
      level: matched ? "info" : "warn",
      source: "background",
      stage: "scan-complete",
      message: "扫描完成",
      detail: {
        scanned: scannedItems,
        matched: resolvedItems,
        resolvedCardItems,
        detailFailureCount,
        parseFailures: parseFailures.length,
        deduplicatedItems,
        scanListItems: scanList.length,
        skippedItems: skippedItems.length,
        directResources: directResourceSummary
      }
    });
    await saveJobReport(createJobReport({
      jobId,
      runFolder: settings.runFolder,
      startedAt: settings.startedAt,
      scannedItems,
      resolvedCardItems,
      resolvedItems,
      deduplicatedItems,
      deduplicatedItemSamples,
      submittedDownloads,
      parseFailures,
      qualityFailures,
      scanList,
      skippedItems,
      directResourceSummary,
      downloadFailures
    }));
    await mergeJobStatus(jobId, {
      status: "downloading",
      stage: "downloading",
      message: `解析到 ${matched} 张原图链接，正在启动下载...`,
      scanned: scannedItems,
      matched: resolvedItems,
      detailFailureCount: parseFailures.length || Number(detailFailureCount || 0),
      scannedItems,
      resolvedCardItems,
      resolvedItems,
      deduplicatedItems,
      parseFailureCount: parseFailures.length || Number(detailFailureCount || 0),
      scanListItems: scanList.length,
      skippedItems: skippedItems.length,
      directResourceSummary,
      current: matched,
      total: scanned
    });

    const downloadResult = await downloadImages({
      jobId,
      tabId,
      images,
      folder: settings.folder,
      accountLabel: settings.accountLabel,
      startedAt: settings.startedAt,
      runId: settings.runId,
      delayMs: settings.delayMs
    });
    submittedDownloads = Number(downloadResult.started || 0);
    qualityFailures = normalizeFailureItems(downloadResult.qualityFailures, "quality");
    downloadFailures = normalizeFailureItems(downloadResult.failures, "download");
    await appendJobLog({
      jobId,
      level: qualityFailures.length || downloadFailures.length ? "warn" : "info",
      source: "background",
      stage: "download",
      message: "下载任务已提交",
      detail: {
        started: submittedDownloads,
        qualityFailures: qualityFailures.length,
        failures: downloadFailures.length,
        runId: downloadResult.runId,
        runFolder: downloadResult.runFolder
      }
    });

    const endedAt = Date.now();
    const report = createJobReport({
      jobId,
      runFolder: downloadResult.runFolder || settings.runFolder,
      startedAt: settings.startedAt,
      endedAt,
      scannedItems,
      resolvedCardItems,
      resolvedItems,
      deduplicatedItems,
      deduplicatedItemSamples,
      submittedDownloads,
      parseFailures,
      qualityFailures,
      scanList,
      skippedItems,
      directResourceSummary,
      downloadFailures
    });
    await saveJobReport(report);
    await appendJobLog({
      jobId,
      level: report.parseFailures.length || report.qualityFailures.length || report.downloadFailures.length ? "warn" : "info",
      source: "background",
      stage: "report",
      message: "任务报告已写入 chrome.storage.local",
      detail: summarizeJobReport(report)
    });

    await mergeJobStatus(jobId, {
      status: "done",
      stage: "done",
      message: `已启动 ${submittedDownloads} 个下载任务。`,
      downloadStarted: submittedDownloads,
      submittedDownloads,
      downloadFailures: downloadFailures.length,
      downloadFailureCount: downloadFailures.length,
      scannedItems,
      resolvedCardItems,
      resolvedItems,
      deduplicatedItems,
      parseFailureCount: parseFailures.length,
      scanListItems: scanList.length,
      skippedItems: skippedItems.length,
      directResourceSummary,
      qualityFailures: qualityFailures.length,
      qualityFailureCount: qualityFailures.length,
      runId: downloadResult.runId,
      runFolder: downloadResult.runFolder,
      endedAt
    });
  } catch (error) {
    const endedAt = Date.now();
    const report = createJobReport({
      jobId,
      runFolder: settings.runFolder,
      startedAt: settings.startedAt,
      endedAt,
      scannedItems,
      resolvedCardItems,
      resolvedItems,
      deduplicatedItems,
      deduplicatedItemSamples,
      submittedDownloads,
      parseFailures,
      qualityFailures,
      scanList,
      skippedItems,
      directResourceSummary,
      downloadFailures,
      diagnostic: {
        reason: error?.message || String(error),
        stage: "error"
      }
    });
    await saveJobReport(report);
    await appendJobLog({
      jobId,
      level: "error",
      source: "background",
      stage: "error",
      message: error?.message || String(error),
      detail: summarizeJobReport(report)
    });
    await mergeJobStatus(jobId, {
      status: "error",
      stage: "error",
      message: error?.message || String(error),
      scannedItems,
      resolvedCardItems,
      resolvedItems,
      deduplicatedItems,
      parseFailureCount: parseFailures.length,
      scanListItems: scanList.length,
      skippedItems: skippedItems.length,
      directResourceSummary,
      submittedDownloads,
      qualityFailures: qualityFailures.length,
      qualityFailureCount: qualityFailures.length,
      downloadFailureCount: downloadFailures.length,
      downloadFailures: downloadFailures.length,
      endedAt
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

  const scanned = Number(payload.scanned ?? current.scanned ?? 0);
  const matched = Number(payload.matched ?? current.matched ?? 0);
  const detailFailureCount = Number(payload.detailFailureCount ?? current.detailFailureCount ?? 0);
  const resolvedCardItems = Number(payload.resolvedCardItems ?? current.resolvedCardItems ?? matched);
  const deduplicatedItems = Number(payload.deduplicatedItems ?? current.deduplicatedItems ?? 0);

  await saveJobStatus({
    ...current,
    status: "running",
    stage: payload.stage || current.stage,
    message: payload.message || current.message,
    tabId: sender?.tab?.id || current.tabId,
    scanned,
    matched,
    detailFailureCount,
    scannedItems: scanned,
    resolvedCardItems,
    resolvedItems: matched,
    deduplicatedItems,
    parseFailureCount: detailFailureCount,
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
  await saveJobReport(createJobReport({
    jobId: current.id,
    runFolder: current.runFolder || current.settings?.runFolder || "",
    startedAt: current.startedAt || current.settings?.startedAt || Date.now(),
    endedAt: canceled.endedAt,
    scannedItems: current.scannedItems ?? current.scanned ?? 0,
    resolvedCardItems: current.resolvedCardItems ?? current.matched ?? 0,
    resolvedItems: current.resolvedItems ?? current.matched ?? 0,
    deduplicatedItems: current.deduplicatedItems ?? 0,
    submittedDownloads: current.submittedDownloads ?? current.downloadStarted ?? 0,
    parseFailures: [],
    qualityFailures: [],
    deduplicatedItemSamples: [],
    scanList: [],
    skippedItems: [],
    directResourceSummary: null,
    downloadFailures: []
  }));
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
    scannedItems: 0,
    resolvedCardItems: 0,
    resolvedItems: 0,
    parseFailureCount: 0,
    deduplicatedItems: 0,
    current: 0,
    total: 0,
    downloadStarted: 0,
    submittedDownloads: 0,
    scanListItems: 0,
    skippedItems: 0,
    directResourceSummary: null,
    qualityFailures: 0,
    qualityFailureCount: 0,
    downloadFailures: 0,
    downloadFailureCount: 0
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

async function saveJobReport(report) {
  await chrome.storage.local.set({
    [JOB_REPORT_KEY]: report,
    [JOB_MANIFEST_KEY]: report
  });
  return report;
}

function createJobReport({
  jobId,
  runFolder,
  startedAt,
  endedAt = null,
  scannedItems = 0,
  resolvedCardItems = 0,
  resolvedItems = 0,
  deduplicatedItems = 0,
  deduplicatedItemSamples = [],
  submittedDownloads = 0,
  parseFailures = [],
  qualityFailures = [],
  downloadFailures = [],
  scanList = [],
  skippedItems = [],
  directResourceSummary = null,
  diagnostic = null
} = {}) {
  return {
    jobId: String(jobId || ""),
    runFolder: String(runFolder || ""),
    startedAt: normalizeTimestamp(startedAt) || Date.now(),
    endedAt: endedAt ? normalizeTimestamp(endedAt) || Date.now() : null,
    scannedItems: Number(scannedItems) || 0,
    resolvedCardItems: Number(resolvedCardItems) || 0,
    resolvedItems: Number(resolvedItems) || 0,
    deduplicatedItems: Number(deduplicatedItems) || 0,
    deduplicatedItemSamples: normalizeFailureItems(deduplicatedItemSamples, "dedupe"),
    submittedDownloads: Number(submittedDownloads) || 0,
    parseFailures: normalizeFailureItems(parseFailures, "resolve"),
    qualityFailures: normalizeFailureItems(qualityFailures, "quality"),
    downloadFailures: normalizeFailureItems(downloadFailures, "download"),
    scanList: normalizeScanListItems(scanList),
    skippedItems: normalizeFailureItems(skippedItems, "skip"),
    directResourceSummary: sanitizeReportDiagnostic(directResourceSummary, 3000),
    diagnostic: sanitizeReportDiagnostic(diagnostic)
  };
}

function summarizeJobReport(report = {}) {
  return {
    jobId: report.jobId || "",
    runFolder: report.runFolder || "",
    scannedItems: report.scannedItems || 0,
    resolvedCardItems: report.resolvedCardItems || 0,
    resolvedItems: report.resolvedItems || 0,
    deduplicatedItems: report.deduplicatedItems || 0,
    submittedDownloads: report.submittedDownloads || 0,
    parseFailures: Array.isArray(report.parseFailures) ? report.parseFailures.length : 0,
    qualityFailures: Array.isArray(report.qualityFailures) ? report.qualityFailures.length : 0,
    downloadFailures: Array.isArray(report.downloadFailures) ? report.downloadFailures.length : 0,
    scanListItems: Array.isArray(report.scanList) ? report.scanList.length : 0,
    skippedItems: Array.isArray(report.skippedItems) ? report.skippedItems.length : 0,
    directResourceSummary: report.directResourceSummary || null,
    storageKeys: [JOB_REPORT_KEY, JOB_MANIFEST_KEY]
  };
}

function normalizeScanListItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, fallbackIndex) => normalizeScanListItem(item, fallbackIndex + 1))
    .filter(Boolean);
}

function normalizeScanListItem(item, fallbackIndex) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const scanIndex = Number(item.scanIndex || item.index || fallbackIndex || 0);
  const pageOrder = Number(item.pageOrder || scanIndex || fallbackIndex || 0);

  return {
    scanIndex,
    pageOrder,
    imageKey: truncateText(item.imageKey || buildReportImageKey(item, scanIndex), 80),
    thumbnailUrl: normalizeFailureUrlSummary(item.thumbnailUrl || item.thumbnail || item.url),
    prompt: truncateText(item.prompt || item.alt || "", 240),
    date: truncateText(item.date || "", 80),
    position: sanitizeReportDiagnostic(item.position, 1000),
    source: truncateText(item.source || "", 80),
    status: truncateText(item.status || "", 80),
    reason: truncateText(item.reason || "", 200),
    resolvedUrl: normalizeFailureUrlSummary(item.resolvedUrl || item.resolvedOriginalUrl || ""),
    directResourceDisposition: truncateText(item.directResourceDisposition || "", 80),
    directSource: truncateText(item.directSource || "", 80),
    directSources: Array.isArray(item.directSources)
      ? item.directSources.map((source) => truncateText(source, 80)).slice(0, 20)
      : [],
    directResourceCount: Number(item.directResourceCount || 0)
  };
}

function normalizeFailureItems(items, fallbackStage = "") {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => normalizeFailureItem(item, fallbackStage, index + 1))
    .filter(Boolean);
}

function normalizeFailureItem(item, fallbackStage = "", fallbackIndex = 0) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const index = Number(item.index || item.scanIndex || fallbackIndex || 0);
  const scanIndex = Number(item.scanIndex || index || fallbackIndex || 0);
  const pageOrder = Number(item.pageOrder || scanIndex || index || fallbackIndex || 0);
  const diagnostic = item.diagnostic !== undefined
    ? item.diagnostic
    : diagnosticFromFailureItem(item);
  const quality = item.quality !== undefined
    ? item.quality
    : diagnostic?.quality;

  return {
    index,
    scanIndex,
    pageOrder,
    imageKey: truncateText(item.imageKey || buildReportImageKey(item, index), 80),
    thumbnailUrl: normalizeFailureUrlSummary(item.thumbnailUrl || item.thumbnail || item.url),
    prompt: truncateText(item.prompt || item.alt || "", 240),
    date: truncateText(item.date || "", 80),
    source: truncateText(item.source || "", 80),
    reason: truncateText(item.reason || item.error || "unknown-failure", 200),
    stage: truncateText(item.stage || fallbackStage || "", 80),
    diagnostic: sanitizeReportDiagnostic(diagnostic),
    quality: sanitizeReportDiagnostic(quality || createQualityResult({
      rejectReason: item.reason || item.error || fallbackStage || "not-checked"
    }), 1000)
  };
}

function diagnosticFromFailureItem(item) {
  const diagnostic = {};
  const skipKeys = new Set([
    "index",
    "scanIndex",
    "pageOrder",
    "imageKey",
    "thumbnailUrl",
    "thumbnail",
    "prompt",
    "alt",
    "date",
    "source",
    "position",
    "directResourceDisposition",
    "directSource",
    "directSources",
    "directResourceCount",
    "reason",
    "stage",
    "diagnostic",
    "quality"
  ]);

  for (const [key, value] of Object.entries(item)) {
    if (skipKeys.has(key)) {
      continue;
    }

    diagnostic[key] = /url/i.test(key) && typeof value === "string"
      ? normalizeFailureUrlSummary(value)
      : value;
  }

  return Object.keys(diagnostic).length ? diagnostic : null;
}

function buildDownloadFailureItem({
  index,
  scanIndex = 0,
  pageOrder = 0,
  image = {},
  imageKey = "",
  reason = "",
  stage = "download",
  diagnostic = null,
  quality = null
} = {}) {
  return normalizeFailureItem({
    index,
    scanIndex: scanIndex || image.scanIndex || index,
    pageOrder: pageOrder || image.pageOrder || image.scanIndex || index,
    imageKey,
    thumbnailUrl: image.thumbnailUrl || image.thumbnail || image.url || "",
    prompt: image.prompt || image.alt || "",
    date: image.date || "",
    source: image.source || "",
    reason,
    stage,
    diagnostic,
    quality
  }, stage, index);
}

function normalizeFailureUrlSummary(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return summarizeDownloadUrl(value);
  }

  if (typeof value === "object") {
    return sanitizeReportDiagnostic(value, 1000);
  }

  return { value: truncateText(value, 240) };
}

function buildReportImageKey(item, index) {
  const keyInput = JSON.stringify([
    item.thumbnailUrl || item.thumbnail || item.url || "",
    item.date || "",
    item.prompt || "",
    index
  ]);

  return `img-${shortHashText(keyInput, 12)}`;
}

function sanitizeReportDiagnostic(value, maxLength = 3000) {
  if (!value) {
    return null;
  }

  if (typeof value !== "object") {
    return truncateText(value, maxLength);
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
    return { value: truncateText(String(value), maxLength) };
  }
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
  const folder = sanitizePathSegment(payload?.folder || DEFAULT_FOLDER, DEFAULT_FOLDER);
  const accountLabel = normalizeAccountLabel(payload?.accountLabel);
  const startedAt = normalizeTimestamp(payload?.startedAt) || Date.now();
  const jobId = payload?.jobId || "";
  const runContext = buildRunContext({
    folder,
    accountLabel,
    startedAt,
    jobId,
    runId: payload?.runId
  });
  const { runId, runFolder } = runContext;
  const delayMs = clamp(Number(payload?.delayMs) || 400, 0, 5000);
  const tabId = Number(payload?.tabId || 0);

  let started = 0;
  const failures = [];
  const qualityFailures = [];

  await appendJobLog({
    jobId,
    level: "info",
    source: "background",
    stage: "download",
    message: "下载目录已创建",
    detail: {
      folder,
      accountLabel,
      runId,
      runFolder,
      total: images.length
    }
  });

  for (const [index, image] of images.entries()) {
    if (!image?.url) {
      continue;
    }

    const itemNumber = index + 1;
    const scanIndex = normalizedScanIndex(image, itemNumber);
    const pageOrder = Number(image.pageOrder || scanIndex || itemNumber);
    const imageKey = buildImageKey(image);
    const shortHash = imageKeyToShortHash(imageKey);
    const urlSummary = summarizeDownloadUrl(image.url);
    await appendJobLog({
      jobId,
      level: "info",
      source: "background",
      stage: "download",
      message: "已解析候选 URL",
      detail: {
        index: itemNumber,
        scanIndex,
        pageOrder,
        total: images.length,
        imageKey,
        shortHash,
        source: image.source || "",
        runFolder,
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
        const failureItem = buildDownloadFailureItem({
          index: itemNumber,
          scanIndex,
          pageOrder,
          image,
          imageKey,
          reason: target.reason,
          stage: isQualityFailureResult(target) ? "quality-check" : "download-prepare",
          quality: target.quality,
          diagnostic: {
            status: target.status || 0,
            contentType: target.contentType || "",
            url: target.urlSummary || urlSummary,
            diagnostic: target.diagnostic || null,
            quality: target.quality || null
          }
        });
        if (isQualityFailureResult(target)) {
          qualityFailures.push(failureItem);
        } else {
          failures.push(failureItem);
        }
        await appendJobLog({
          jobId,
          level: "warn",
          source: "background",
          stage: "download",
          message: "下载前取图失败，未提交下载任务",
          detail: {
            index: itemNumber,
            scanIndex,
            pageOrder,
            total: images.length,
            imageKey,
            shortHash,
            source: image.source || "",
            runFolder,
            reason: target.reason,
            status: target.status || 0,
            contentType: target.contentType || "",
            url: target.urlSummary || urlSummary,
            diagnostic: target.diagnostic || null,
            quality: target.quality || null
          }
        });

        continue;
      }

      await appendJobLog({
        jobId,
        level: "info",
        source: "background",
        stage: "quality-check",
        message: "quality-accepted: image passed original-quality gate",
        detail: {
          index: itemNumber,
          scanIndex,
          pageOrder,
          total: images.length,
          imageKey,
          shortHash,
          source: image.source || "",
          runFolder,
          quality: target.quality,
          sourceUrl: target.sourceUrl ? summarizeDownloadUrl(target.sourceUrl) : null,
          downloadUrlKind: target.downloadUrlKind || "blob"
        }
      });

      const extension = sanitizeFileExtension(
        target.extension || extensionFromMimeType(target.mimeType) || guessExtension(image.url)
      );
      const baseName = buildBaseName(image, itemNumber, shortHash, runContext.dateSegment);
      const filename = `${runFolder}/${baseName}.${extension}`;
      const submitted = await submitImageDownload({
        tabId,
        jobId,
        image,
        target,
        filename,
        imageKey,
        shortHash,
        runFolder,
        index: itemNumber,
        total: images.length
      });

      if (!submitted.ok) {
        failures.push(buildDownloadFailureItem({
          index: itemNumber,
          scanIndex,
          pageOrder,
          image,
          imageKey,
          reason: submitted.reason,
          stage: "download-submit",
          quality: submitted.quality || target.quality,
          diagnostic: {
            filename,
            url: urlSummary,
            downloadUrlKind: target.downloadUrlKind || "direct",
            quality: submitted.quality || target.quality || null
          }
        }));
        await appendJobLog({
          jobId,
          level: "warn",
          source: "background",
          stage: "download",
          message: "图片下载任务提交失败",
          detail: {
            index: itemNumber,
            scanIndex,
            pageOrder,
            total: images.length,
            imageKey,
            shortHash,
            source: image.source || "",
            runFolder,
            filename,
            reason: submitted.reason,
            url: urlSummary,
            downloadUrlKind: target.downloadUrlKind || "direct",
            quality: submitted.quality || target.quality || null
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
          scanIndex,
          pageOrder,
          total: images.length,
          filename,
          imageKey,
          shortHash,
          source: image.source || "",
          runId,
          runFolder,
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
          scanIndex,
          pageOrder,
          total: images.length,
          filename,
          imageKey,
          shortHash,
          source: image.source || "",
          runId,
          runFolder,
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
      failures.push(buildDownloadFailureItem({
        index: itemNumber,
        scanIndex,
        pageOrder,
        image,
        imageKey,
        reason,
        stage: "download",
        diagnostic: {
          url: urlSummary
        }
      }));
      await appendJobLog({
        jobId,
        level: "warn",
        source: "background",
        stage: "download",
        message: "下载任务处理失败",
        detail: {
          index: itemNumber,
          scanIndex,
          pageOrder,
          total: images.length,
          imageKey,
          shortHash,
          source: image.source || "",
          runFolder,
          reason,
          url: urlSummary
        }
      });
    }

    if (delayMs > 0 && index < images.length - 1) {
      await sleep(delayMs);
    }
  }

  return {
    started,
    failures,
    submittedDownloads: started,
    qualityFailures,
    downloadFailures: failures,
    runId,
    runFolder,
    accountLabel
  };
}

async function resolveDownloadTarget({ tabId, jobId, image, index, total }) {
  const prepared = await prepareImageInContent({
    tabId,
    jobId,
    image,
    index,
    total
  });

  return requireDownloadTargetQuality(prepared, image);
}

function requireDownloadTargetQuality(target = {}, image = {}) {
  const quality = hasExplicitQualityResult(target.quality)
    ? normalizeQualityResult(target.quality, target)
    : null;

  if (!target.ok) {
    return {
      ...target,
      quality: quality || createQualityResult({
        width: target.width || 0,
        height: target.height || 0,
        size: target.size || 0,
        mimeType: target.mimeType || target.contentType || "",
        isOriginalLikely: false,
        rejectReason: target.reason || "prepare-failed"
      })
    };
  }

  if (!quality) {
    return {
      ok: false,
      reason: "missing-quality-result",
      status: target.status || 0,
      contentType: target.contentType || "",
      urlSummary: target.urlSummary || summarizeDownloadUrl(image.url),
      diagnostic: {
        targetUrl: target.sourceUrl ? summarizeDownloadUrl(target.sourceUrl) : target.urlSummary || summarizeDownloadUrl(image.url),
        downloadUrlKind: target.downloadUrlKind || "",
        missingFields: missingQualityFields(target.quality)
      },
      quality: createQualityResult({
        width: target.width || 0,
        height: target.height || 0,
        size: target.size || 0,
        mimeType: target.mimeType || target.contentType || "",
        isOriginalLikely: false,
        rejectReason: "missing-quality-result"
      })
    };
  }

  if (!quality.isOriginalLikely) {
    return {
      ...target,
      ok: false,
      reason: quality.rejectReason || "quality-rejected",
      diagnostic: {
        ...(target.diagnostic && typeof target.diagnostic === "object" ? target.diagnostic : {}),
        quality
      },
      quality
    };
  }

  if (!target.downloadUrl) {
    return {
      ...target,
      ok: false,
      reason: "missing-download-url",
      diagnostic: {
        ...(target.diagnostic && typeof target.diagnostic === "object" ? target.diagnostic : {}),
        quality
      },
      quality
    };
  }

  return {
    ...target,
    width: quality.width,
    height: quality.height,
    size: quality.size,
    mimeType: quality.mimeType || target.mimeType || "",
    quality
  };
}

function hasExplicitQualityResult(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  return ["width", "height", "size", "mimeType", "isOriginalLikely", "rejectReason"]
    .every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function missingQualityFields(value) {
  if (!value || typeof value !== "object") {
    return ["width", "height", "size", "mimeType", "isOriginalLikely", "rejectReason"];
  }

  return ["width", "height", "size", "mimeType", "isOriginalLikely", "rejectReason"]
    .filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
}

function normalizeQualityResult(value = {}, fallback = {}) {
  return {
    ...value,
    width: Number(value.width ?? fallback.width ?? 0) || 0,
    height: Number(value.height ?? fallback.height ?? 0) || 0,
    size: Number(value.size ?? fallback.size ?? 0) || 0,
    mimeType: String(value.mimeType || fallback.mimeType || fallback.contentType || ""),
    isOriginalLikely: value.isOriginalLikely === true,
    rejectReason: String(value.rejectReason || "")
  };
}

function createQualityResult(overrides = {}) {
  return normalizeQualityResult({
    width: 0,
    height: 0,
    size: 0,
    mimeType: "",
    isOriginalLikely: false,
    rejectReason: "not-checked",
    ...overrides
  });
}

function isQualityFailureResult(result = {}) {
  const reason = String(result.reason || result.quality?.rejectReason || "").toLowerCase();
  return Boolean(result.quality && result.quality.isOriginalLikely === false && (
    reason.includes("quality")
    || reason.includes("thumbnail")
    || reason.includes("low-resolution")
    || reason.includes("small-blob")
    || reason.includes("dimension")
    || reason === "missing-quality-result"
  ));
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

async function submitImageDownload({ tabId, jobId, image, target, filename, imageKey, shortHash, runFolder, index, total }) {
  target = requireDownloadTargetQuality({ ...target, ok: true }, image);
  if (!target.ok) {
    return {
      ok: false,
      reason: target.reason || "quality-check-failed",
      quality: target.quality || null
    };
  }

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
          imageKey,
          shortHash,
          runFolder,
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

function buildBaseName(image, index, shortHash, fallbackDate) {
  const prefixIndex = normalizedScanIndex(image, index);
  const datePrefix = sanitizeDateSegment(image.date) || fallbackDate || "unknown-date";
  const title = sanitizePromptForFileName(image.prompt || image.alt || DEFAULT_PROMPT_NAME);
  const safeHash = sanitizePathSegment(shortHash, "image").slice(0, 16);

  return `${String(prefixIndex).padStart(4, "0")}-${datePrefix}-${safeHash}-${title}`;
}

function normalizedScanIndex(image, fallbackIndex) {
  const scanIndex = Number(image?.scanIndex);
  return Number.isFinite(scanIndex) && scanIndex > 0
    ? scanIndex
    : Number(fallbackIndex) || 0;
}

function buildRunContext({ folder, accountLabel, startedAt, jobId, runId }) {
  const timestamp = normalizeTimestamp(startedAt) || Date.now();
  const safeFolder = sanitizePathSegment(folder || DEFAULT_FOLDER, DEFAULT_FOLDER);
  const safeAccountLabel = normalizeAccountLabel(accountLabel);
  const dateSegment = formatLocalDate(timestamp);
  const generatedRunId = buildRunId(timestamp, jobId);
  const safeRunId = sanitizePathSegment(runId || generatedRunId, generatedRunId);

  return {
    folder: safeFolder,
    accountLabel: safeAccountLabel,
    startedAt: timestamp,
    dateSegment,
    runId: safeRunId,
    runFolder: [safeFolder, safeAccountLabel, dateSegment, safeRunId].join("/")
  };
}

function buildRunId(timestamp, jobId) {
  const base = formatCompactTimestamp(timestamp);
  const suffix = shortHashText(`${timestamp}|${jobId || ""}`, 6);
  return `${base}-${suffix}`;
}

function buildImageKey(image) {
  const providedKey = sanitizeProvidedImageKey(image?.imageKey);
  if (providedKey) {
    return providedKey;
  }

  const keyInput = [
    canonicalizeImageUrlForKey(image?.url || ""),
    sanitizeDateSegment(image?.date || ""),
    normalizeKeyText(image?.prompt || ""),
    normalizeKeyText(image?.alt || "")
  ].filter(Boolean).join("|") || "image";

  return `img-${shortHashText(keyInput, 12)}`;
}

function sanitizeProvidedImageKey(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const safe = sanitizePathSegment(text, "image").slice(0, 80);
  return safe.startsWith("img-") ? safe : `img-${safe}`;
}

function imageKeyToShortHash(imageKey) {
  return sanitizePathSegment(String(imageKey || "").replace(/^img-/i, ""), "image").slice(0, 8);
}

function canonicalizeImageUrlForKey(url) {
  try {
    const parsed = new URL(url);

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

function normalizeKeyText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function sanitizePromptForFileName(value) {
  const sanitized = sanitizePathSegment(value || DEFAULT_PROMPT_NAME, DEFAULT_PROMPT_NAME)
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 70)
    .replace(/[.-]+$/g, "");

  return sanitized || DEFAULT_PROMPT_NAME;
}

function normalizeAccountLabel(value) {
  return sanitizePathSegment(value || DEFAULT_ACCOUNT_LABEL, DEFAULT_ACCOUNT_LABEL).slice(0, 80) || DEFAULT_ACCOUNT_LABEL;
}

function sanitizeDateSegment(value) {
  const text = String(value || "").trim();
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  if (match) {
    return match[0];
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? formatLocalDate(parsed) : "";
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function formatLocalDate(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    padNumber(date.getMonth() + 1),
    padNumber(date.getDate())
  ].join("-");
}

function formatCompactTimestamp(timestamp) {
  const date = new Date(timestamp);
  return [
    `${date.getFullYear()}${padNumber(date.getMonth() + 1)}${padNumber(date.getDate())}`,
    `${padNumber(date.getHours())}${padNumber(date.getMinutes())}${padNumber(date.getSeconds())}`
  ].join("-");
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

function sanitizeFileExtension(value) {
  const extension = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "");

  return ["avif", "bmp", "gif", "jpg", "jpeg", "png", "webp"].includes(extension)
    ? (extension === "jpeg" ? "jpg" : extension)
    : "png";
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
  return Boolean(url);
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

function sanitizePathSegment(value, fallback = "download") {
  const fallbackText = cleanPathSegmentText(fallback).slice(0, 120) || "download";
  const cleaned = cleanPathSegmentText(value).slice(0, 120);
  const result = cleaned && !isReservedPathSegment(cleaned) ? cleaned : fallbackText;

  return isReservedPathSegment(result) ? `${result}_` : result;
}

function cleanPathSegmentText(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
    .replace(/\.+$/g, "")
    .replace(/\s+/g, " ");
}

function isReservedPathSegment(value) {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(String(value || ""));
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
