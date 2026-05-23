const DEFAULT_FOLDER = "ChatGPT Images";
const DEFAULT_ACCOUNT_LABEL = "default";
const DEFAULT_PROMPT_NAME = "chatgpt-image";
const JOB_STATUS_KEY = "imageJobStatus";
const JOB_LOGS_KEY = "imageJobLogs";
const JOB_REPORT_KEY = "jobReport";
const JOB_MANIFEST_KEY = "jobManifest";
const DOWNLOAD_HISTORY_KEY = "downloadHistory";
const MAX_LOG_ENTRIES = 300;
const DEFAULT_SPEED_MODE = "standard";
const MAX_DOWNLOAD_CONCURRENCY = 3;
const DEFAULT_DATE_FILTER_MODE = "none";
const DEFAULT_UNKNOWN_DATE_MODE = "skip";
const ZIP_EVALUATION_NOTE = "ZIP 仅评估：继续使用浏览器 downloads API 时不强行 ZIP；未来如需 ZIP，必须先 fetch Blob 后用 JSZip 等库打包，并评估大图集中进内存的风险。本版本不会把大图全部加载进内存。";
const SPEED_PRESETS = {
  stable: { label: "稳定", concurrency: 1, delayMs: 400 },
  standard: { label: "标准", concurrency: 2, delayMs: 100 },
  fast: { label: "快速", concurrency: 3, delayMs: 0 }
};
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

  if (message.type === "START_FAILED_ITEMS_RETRY") {
    startFailedItemsRetryJob(message.payload)
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
  const speed = normalizeSpeedSettings(payload);
  const dateFilter = normalizeDateFilterSettings(payload.dateFilter, startedAt);
  const settings = {
    folder: sanitizePathSegment(payload.folder || DEFAULT_FOLDER, DEFAULT_FOLDER),
    accountLabel: normalizeAccountLabel(payload.accountLabel),
    downloadMode: normalizeDownloadMode(payload.downloadMode),
    dateFilter,
    maxScrolls: clamp(numberOrDefault(payload.maxScrolls, 30), 0, 250),
    speedMode: speed.speedMode,
    speedLabel: speed.speedLabel,
    downloadConcurrency: speed.concurrency,
    delayMs: speed.delayMs,
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
    dateFilter: settings.dateFilter,
    filteredIn: 0,
    filteredOut: 0,
    unknownDateCount: 0,
    unknownDateMode: settings.dateFilter.unknownDateMode,
    directResourceSummary: null,
    qualityFailures: 0,
    qualityFailureCount: 0,
    downloadFailures: 0,
    downloadFailureCount: 0,
    skippedDuplicates: 0,
    skippedDuplicateCount: 0,
    speedMode: settings.speedMode,
    speedLabel: settings.speedLabel,
    downloadConcurrency: settings.downloadConcurrency,
    delayMs: settings.delayMs,
    totalDurationMs: 0,
    downloadDurationMs: 0,
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
    ...dateFilterReportFields(emptyDateFilterResult(settings.dateFilter)),
    directResourceSummary: null,
    downloadFailures: [],
    skippedDuplicates: [],
    speedMode: settings.speedMode,
    speedLabel: settings.speedLabel,
    downloadConcurrency: settings.downloadConcurrency,
    delayMs: settings.delayMs
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
      speedMode: settings.speedMode,
      speedLabel: settings.speedLabel,
      downloadConcurrency: settings.downloadConcurrency,
      delayMs: settings.delayMs,
      folder: settings.folder,
      accountLabel: settings.accountLabel,
      downloadMode: settings.downloadMode,
      dateFilter: settings.dateFilter,
      runId: settings.runId,
      runFolder: settings.runFolder
    }
  });
  await appendJobLog({
    jobId,
    level: "info",
    source: "background",
    stage: "zip-evaluation",
    message: ZIP_EVALUATION_NOTE
  });
  runImageJob(jobId, tabId, settings);

  return status;
}

async function startFailedItemsRetryJob(payload = {}) {
  const current = await getJobStatus();
  if (isActiveStatus(current.status)) {
    return current;
  }

  const tabId = Number(payload.tabId);
  if (!tabId) {
    throw new Error("没有找到可用的 ChatGPT 标签页。");
  }

  const sourceReport = await readLatestJobReport();
  if (!sourceReport?.jobId) {
    throw new Error("当前没有可重试的 jobReport。");
  }

  const retryOfJobId = String(payload.retryOfJobId || sourceReport.jobId || "");
  if (retryOfJobId && sourceReport.jobId && retryOfJobId !== sourceReport.jobId) {
    throw new Error("当前 jobReport 已变化，请重新打开 popup 后再重试。");
  }

  const retryTargets = buildRetryTargetsFromReport(sourceReport);
  if (!retryTargets.length) {
    throw new Error("当前 jobReport 没有解析失败或下载失败项可重试。");
  }

  const startedAt = Date.now();
  const jobId = `${startedAt}-${Math.random().toString(16).slice(2)}`;
  const speed = normalizeSpeedSettings(payload);
  const dateFilter = normalizeDateFilterSettings(payload.dateFilter || sourceReport.dateFilter, startedAt);
  const settings = {
    folder: sanitizePathSegment(payload.folder || DEFAULT_FOLDER, DEFAULT_FOLDER),
    accountLabel: normalizeAccountLabel(payload.accountLabel),
    downloadMode: normalizeDownloadMode(payload.downloadMode),
    dateFilter,
    maxScrolls: clamp(numberOrDefault(payload.maxScrolls, 30), 0, 250),
    speedMode: speed.speedMode,
    speedLabel: speed.speedLabel,
    downloadConcurrency: speed.concurrency,
    delayMs: speed.delayMs,
    startedAt,
    retryOfJobId
  };
  const runContext = buildRunContext({
    folder: settings.folder,
    accountLabel: settings.accountLabel,
    startedAt,
    jobId
  });
  settings.runId = runContext.runId;
  settings.runFolder = runContext.runFolder;

  const retrySource = createRetrySourceSummary(sourceReport, retryTargets);
  const status = {
    id: jobId,
    runId: runContext.runId,
    runFolder: runContext.runFolder,
    retryOfJobId,
    retryTargetCount: retryTargets.length,
    status: "running",
    stage: "retry-scan",
    message: `正在重试 ${retryTargets.length} 个失败项...`,
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
    total: retryTargets.length,
    downloadStarted: 0,
    submittedDownloads: 0,
    scanListItems: 0,
    skippedItems: 0,
    dateFilter: settings.dateFilter,
    filteredIn: 0,
    filteredOut: 0,
    unknownDateCount: 0,
    unknownDateMode: settings.dateFilter.unknownDateMode,
    directResourceSummary: null,
    qualityFailures: 0,
    qualityFailureCount: 0,
    downloadFailures: 0,
    downloadFailureCount: 0,
    skippedDuplicates: 0,
    skippedDuplicateCount: 0,
    speedMode: settings.speedMode,
    speedLabel: settings.speedLabel,
    downloadConcurrency: settings.downloadConcurrency,
    delayMs: settings.delayMs,
    totalDurationMs: 0,
    downloadDurationMs: 0,
    startedAt,
    endedAt: null,
    settings
  };

  activeJob = { id: jobId, tabId };
  await saveJobStatus(status);
  await saveJobReport(createJobReport({
    jobId,
    retryOfJobId,
    retrySource,
    retryTargets,
    runFolder: runContext.runFolder,
    startedAt,
    scannedItems: 0,
    resolvedCardItems: 0,
    resolvedItems: 0,
    submittedDownloads: 0,
    submittedItems: [],
    parseFailures: [],
    qualityFailures: [],
    deduplicatedItems: 0,
    deduplicatedItemSamples: [],
    scanList: [],
    skippedItems: [],
    ...dateFilterReportFields(emptyDateFilterResult(settings.dateFilter)),
    directResourceSummary: null,
    downloadFailures: [],
    skippedDuplicates: [],
    speedMode: settings.speedMode,
    speedLabel: settings.speedLabel,
    downloadConcurrency: settings.downloadConcurrency,
    delayMs: settings.delayMs
  }));
  await appendJobLog({
    jobId,
    level: "info",
    source: "background",
    stage: "retry-start",
    message: "失败项重试任务启动",
    detail: {
      tabId,
      retryOfJobId,
      retryTargets: retryTargets.length,
      parseFailures: retrySource.parseFailureCount,
      downloadFailures: retrySource.downloadFailureCount,
      qualityFailuresSkipped: retrySource.qualityFailuresSkipped,
      downloadMode: settings.downloadMode,
      dateFilter: settings.dateFilter,
      runId: settings.runId,
      runFolder: settings.runFolder
    }
  });
  await appendJobLog({
    jobId,
    level: "info",
    source: "background",
    stage: "zip-evaluation",
    message: ZIP_EVALUATION_NOTE
  });
  runFailedItemsRetryJob(jobId, tabId, settings, sourceReport, retryTargets);

  return status;
}

async function runImageJob(jobId, tabId, settings) {
  let scannedItems = 0;
  let resolvedCardItems = 0;
  let resolvedItems = 0;
  let deduplicatedItems = 0;
  let deduplicatedItemSamples = [];
  let submittedDownloads = 0;
  let submittedItems = [];
  let parseFailures = [];
  let qualityFailures = [];
  let downloadFailures = [];
  let skippedDuplicates = [];
  let scanList = [];
  let skippedItems = [];
  let directResourceSummary = null;
  let dateFilterResult = emptyDateFilterResult(settings.dateFilter);

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
    dateFilterResult = emptyDateFilterResult(settings.dateFilter);
    const dateFilteredImages = Array.isArray(images) ? images : [];
    await appendJobLog({
      jobId,
      level: "info",
      source: "background",
      stage: "date-filter",
      message: "date-filter-deferred-until-download-prepare",
      detail: {
        dateFilter: dateFilterResult.dateFilter,
        candidates: dateFilteredImages.length,
        policy: "unknown DOM dates are fetched first so response-header.last-modified can be used before filtering"
      }
    });
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
        dateFilter: {
          ...summarizeDateFilterResult(dateFilterResult),
          deferredUntilDownloadPrepare: true
        },
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
      ...dateFilterReportFields(dateFilterResult),
      directResourceSummary,
      downloadFailures,
      skippedDuplicates,
      speedMode: settings.speedMode,
      speedLabel: settings.speedLabel,
      downloadConcurrency: settings.downloadConcurrency,
      delayMs: settings.delayMs
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
      dateFilter: dateFilterResult.dateFilter,
      filteredIn: dateFilterResult.filteredIn,
      filteredOut: dateFilterResult.filteredOut,
      unknownDateCount: dateFilterResult.unknownDateCount,
      unknownDateMode: dateFilterResult.dateFilter.unknownDateMode,
      directResourceSummary,
      speedMode: settings.speedMode,
      speedLabel: settings.speedLabel,
      downloadConcurrency: settings.downloadConcurrency,
      delayMs: settings.delayMs,
      current: 0,
      total: matched
    });

    const downloadResult = await downloadImages({
      jobId,
      tabId,
      images: dateFilteredImages,
      folder: settings.folder,
      accountLabel: settings.accountLabel,
      dateFilter: dateFilterResult.dateFilter,
      startedAt: settings.startedAt,
      runId: settings.runId,
      delayMs: settings.delayMs,
      speedMode: settings.speedMode,
      downloadConcurrency: settings.downloadConcurrency,
      downloadMode: settings.downloadMode
    });
    submittedDownloads = Number(downloadResult.started || 0);
    dateFilterResult = downloadResult.dateFilterResult || dateFilterResult;
    submittedItems = normalizeSubmittedDownloadItems(downloadResult.submittedItems);
    qualityFailures = normalizeFailureItems(downloadResult.qualityFailures, "quality");
    downloadFailures = normalizeFailureItems(downloadResult.failures, "download");
    skippedDuplicates = normalizeSkippedDuplicateItems(downloadResult.skippedDuplicates);
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
        skippedDuplicates: skippedDuplicates.length,
        dateFilter: summarizeDateFilterResult(dateFilterResult),
        runId: downloadResult.runId,
        runFolder: downloadResult.runFolder,
        speedMode: downloadResult.speedMode,
        speedLabel: downloadResult.speedLabel,
        concurrency: downloadResult.concurrency,
        delayMs: downloadResult.delayMs,
        durationMs: downloadResult.durationMs
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
      submittedItems,
      parseFailures,
      qualityFailures,
      scanList,
      skippedItems,
      ...dateFilterReportFields(dateFilterResult),
      directResourceSummary,
      downloadFailures,
      skippedDuplicates,
      speedMode: downloadResult.speedMode || settings.speedMode,
      speedLabel: downloadResult.speedLabel || settings.speedLabel,
      downloadConcurrency: downloadResult.concurrency || settings.downloadConcurrency,
      delayMs: downloadResult.delayMs ?? settings.delayMs,
      downloadDurationMs: downloadResult.durationMs,
      downloadStartedAt: downloadResult.startedAt,
      downloadEndedAt: downloadResult.endedAt
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
      skippedDuplicates: skippedDuplicates.length,
      skippedDuplicateCount: skippedDuplicates.length,
      speedMode: downloadResult.speedMode || settings.speedMode,
      speedLabel: downloadResult.speedLabel || settings.speedLabel,
      downloadConcurrency: downloadResult.concurrency || settings.downloadConcurrency,
      delayMs: downloadResult.delayMs ?? settings.delayMs,
      totalDurationMs: endedAt - settings.startedAt,
      downloadDurationMs: downloadResult.durationMs || 0,
      scannedItems,
      resolvedCardItems,
      resolvedItems,
      deduplicatedItems,
      parseFailureCount: parseFailures.length,
      scanListItems: scanList.length,
      skippedItems: skippedItems.length,
      dateFilter: dateFilterResult.dateFilter,
      filteredIn: dateFilterResult.filteredIn,
      filteredOut: dateFilterResult.filteredOut,
      unknownDateCount: dateFilterResult.unknownDateCount,
      unknownDateMode: dateFilterResult.dateFilter.unknownDateMode,
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
      submittedItems,
      parseFailures,
      qualityFailures,
      scanList,
      skippedItems,
      ...dateFilterReportFields(dateFilterResult),
      directResourceSummary,
      downloadFailures,
      skippedDuplicates,
      speedMode: settings.speedMode,
      speedLabel: settings.speedLabel,
      downloadConcurrency: settings.downloadConcurrency,
      delayMs: settings.delayMs,
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
      dateFilter: dateFilterResult.dateFilter,
      filteredIn: dateFilterResult.filteredIn,
      filteredOut: dateFilterResult.filteredOut,
      unknownDateCount: dateFilterResult.unknownDateCount,
      unknownDateMode: dateFilterResult.dateFilter.unknownDateMode,
      directResourceSummary,
      submittedDownloads,
      qualityFailures: qualityFailures.length,
      qualityFailureCount: qualityFailures.length,
      downloadFailureCount: downloadFailures.length,
      downloadFailures: downloadFailures.length,
      skippedDuplicates: skippedDuplicates.length,
      skippedDuplicateCount: skippedDuplicates.length,
      speedMode: settings.speedMode,
      speedLabel: settings.speedLabel,
      downloadConcurrency: settings.downloadConcurrency,
      delayMs: settings.delayMs,
      totalDurationMs: endedAt - settings.startedAt,
      endedAt
    });
  } finally {
    if (activeJob?.id === jobId) {
      activeJob = null;
    }
  }
}

async function runFailedItemsRetryJob(jobId, tabId, settings, sourceReport, retryTargets) {
  let scannedItems = 0;
  let resolvedCardItems = 0;
  let resolvedItems = 0;
  let deduplicatedItems = 0;
  let deduplicatedItemSamples = [];
  let submittedDownloads = 0;
  let submittedItems = [];
  let parseFailures = [];
  let qualityFailures = [];
  let downloadFailures = [];
  let skippedDuplicates = [];
  let scanList = [];
  let skippedItems = [];
  let directResourceSummary = null;
  let dateFilterResult = emptyDateFilterResult(settings.dateFilter);
  const retryOfJobId = settings.retryOfJobId || sourceReport?.jobId || "";
  const retrySource = createRetrySourceSummary(sourceReport, retryTargets);

  try {
    await ensureContentScript(tabId);
    await appendJobLog({
      jobId,
      level: "info",
      source: "background",
      stage: "retry-scan",
      message: "开始重新扫描当前页面以匹配失败项",
      detail: {
        retryOfJobId,
        retryTargets: retryTargets.length,
        maxScrolls: settings.maxScrolls
      }
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
      throw new Error(scanResponse?.error || "失败项重试扫描失败，请刷新 ChatGPT 页面后重试。");
    }

    const { images, scanned, matched, detailFailureCount } = scanResponse.result;
    const allParseFailures = normalizeFailureItems(scanResponse.result?.parseFailures, "resolve");
    scannedItems = Number(scanned || 0);
    resolvedItems = Number(matched || 0);
    resolvedCardItems = Number(scanResponse.result?.resolvedCardItems ?? Math.max(scannedItems - allParseFailures.length, resolvedItems));
    deduplicatedItems = Number(scanResponse.result?.deduplicatedItems ?? Math.max(resolvedCardItems - resolvedItems, 0));
    deduplicatedItemSamples = normalizeFailureItems(scanResponse.result?.deduplicatedItemSamples, "dedupe");
    scanList = normalizeScanListItems(scanResponse.result?.scanList);
    skippedItems = normalizeFailureItems(scanResponse.result?.skippedItems, "skip");
    directResourceSummary = sanitizeReportDiagnostic(scanResponse.result?.directResourceSummary, 3000);

    const downloadHistory = await readDownloadHistory();
    const retrySelection = selectRetryImages({
      images,
      parseFailures: allParseFailures,
      retryTargets,
      retryOfJobId,
      downloadHistory,
      downloadMode: settings.downloadMode
    });
    parseFailures = normalizeFailureItems(retrySelection.parseFailures, "resolve");
    skippedDuplicates = normalizeSkippedDuplicateItems(retrySelection.skippedDuplicates);
    dateFilterResult = emptyDateFilterResult(settings.dateFilter);
    const dateFilteredImages = Array.isArray(retrySelection.images) ? retrySelection.images : [];

    await appendJobLog({
      jobId,
      level: "info",
      source: "background",
      stage: "retry-select",
      message: "失败项重试目标匹配完成",
      detail: {
        retryOfJobId,
        retryTargets: retryTargets.length,
        matchedImages: retrySelection.images.length,
        parseFailures: parseFailures.length,
        preSkippedDuplicates: skippedDuplicates.length,
        missingTargets: retrySelection.missingTargets.length,
        dateFilter: {
          ...summarizeDateFilterResult(dateFilterResult),
          deferredUntilDownloadPrepare: true,
          candidates: dateFilteredImages.length
        }
      }
    });

    await saveJobReport(createJobReport({
      jobId,
      retryOfJobId,
      retrySource,
      retryTargets,
      runFolder: settings.runFolder,
      startedAt: settings.startedAt,
      scannedItems,
      resolvedCardItems,
      resolvedItems: retrySelection.images.length,
      deduplicatedItems,
      deduplicatedItemSamples,
      submittedDownloads,
      submittedItems,
      parseFailures,
      qualityFailures,
      scanList,
      skippedItems,
      ...dateFilterReportFields(dateFilterResult),
      directResourceSummary,
      downloadFailures,
      skippedDuplicates,
      speedMode: settings.speedMode,
      speedLabel: settings.speedLabel,
      downloadConcurrency: settings.downloadConcurrency,
      delayMs: settings.delayMs
    }));
    await mergeJobStatus(jobId, {
      status: "downloading",
      stage: "retry-downloading",
      message: `已匹配 ${retrySelection.images.length} 个失败项，正在重试下载...`,
      scanned: scannedItems,
      matched: retrySelection.images.length,
      detailFailureCount: parseFailures.length || Number(detailFailureCount || 0),
      scannedItems,
      resolvedCardItems,
      resolvedItems: retrySelection.images.length,
      deduplicatedItems,
      parseFailureCount: parseFailures.length,
      scanListItems: scanList.length,
      skippedItems: skippedItems.length,
      dateFilter: dateFilterResult.dateFilter,
      filteredIn: dateFilterResult.filteredIn,
      filteredOut: dateFilterResult.filteredOut,
      unknownDateCount: dateFilterResult.unknownDateCount,
      unknownDateMode: dateFilterResult.dateFilter.unknownDateMode,
      directResourceSummary,
      speedMode: settings.speedMode,
      speedLabel: settings.speedLabel,
      downloadConcurrency: settings.downloadConcurrency,
      delayMs: settings.delayMs,
      skippedDuplicates: skippedDuplicates.length,
      skippedDuplicateCount: skippedDuplicates.length,
      current: 0,
      total: retryTargets.length
    });

    const downloadResult = await downloadImages({
      jobId,
      tabId,
      images: dateFilteredImages,
      folder: settings.folder,
      accountLabel: settings.accountLabel,
      dateFilter: dateFilterResult.dateFilter,
      startedAt: settings.startedAt,
      runId: settings.runId,
      delayMs: settings.delayMs,
      speedMode: settings.speedMode,
      downloadConcurrency: settings.downloadConcurrency,
      downloadMode: settings.downloadMode
    });
    submittedDownloads = Number(downloadResult.started || 0);
    dateFilterResult = downloadResult.dateFilterResult || dateFilterResult;
    submittedItems = normalizeSubmittedDownloadItems(downloadResult.submittedItems);
    qualityFailures = normalizeFailureItems(downloadResult.qualityFailures, "quality");
    downloadFailures = normalizeFailureItems(downloadResult.failures, "download");
    skippedDuplicates = normalizeSkippedDuplicateItems([
      ...skippedDuplicates,
      ...(downloadResult.skippedDuplicates || [])
    ]);

    const endedAt = Date.now();
    const report = createJobReport({
      jobId,
      retryOfJobId,
      retrySource,
      retryTargets,
      runFolder: downloadResult.runFolder || settings.runFolder,
      startedAt: settings.startedAt,
      endedAt,
      scannedItems,
      resolvedCardItems,
      resolvedItems: retrySelection.images.length,
      deduplicatedItems,
      deduplicatedItemSamples,
      submittedDownloads,
      submittedItems,
      parseFailures,
      qualityFailures,
      scanList,
      skippedItems,
      ...dateFilterReportFields(dateFilterResult),
      directResourceSummary,
      downloadFailures,
      skippedDuplicates,
      speedMode: downloadResult.speedMode || settings.speedMode,
      speedLabel: downloadResult.speedLabel || settings.speedLabel,
      downloadConcurrency: downloadResult.concurrency || settings.downloadConcurrency,
      delayMs: downloadResult.delayMs ?? settings.delayMs,
      downloadDurationMs: downloadResult.durationMs,
      downloadStartedAt: downloadResult.startedAt,
      downloadEndedAt: downloadResult.endedAt
    });
    await saveJobReport(report);
    await appendJobLog({
      jobId,
      level: report.parseFailures.length || report.qualityFailures.length || report.downloadFailures.length ? "warn" : "info",
      source: "background",
      stage: "retry-report",
      message: "失败项重试报告已写入 chrome.storage.local",
      detail: summarizeJobReport(report)
    });

    await mergeJobStatus(jobId, {
      status: "done",
      stage: "done",
      message: `失败项重试完成，已启动 ${submittedDownloads} 个下载任务。`,
      downloadStarted: submittedDownloads,
      submittedDownloads,
      downloadFailures: downloadFailures.length,
      downloadFailureCount: downloadFailures.length,
      skippedDuplicates: skippedDuplicates.length,
      skippedDuplicateCount: skippedDuplicates.length,
      speedMode: downloadResult.speedMode || settings.speedMode,
      speedLabel: downloadResult.speedLabel || settings.speedLabel,
      downloadConcurrency: downloadResult.concurrency || settings.downloadConcurrency,
      delayMs: downloadResult.delayMs ?? settings.delayMs,
      totalDurationMs: endedAt - settings.startedAt,
      downloadDurationMs: downloadResult.durationMs || 0,
      scannedItems,
      resolvedCardItems,
      resolvedItems: retrySelection.images.length,
      deduplicatedItems,
      parseFailureCount: parseFailures.length,
      scanListItems: scanList.length,
      skippedItems: skippedItems.length,
      dateFilter: dateFilterResult.dateFilter,
      filteredIn: dateFilterResult.filteredIn,
      filteredOut: dateFilterResult.filteredOut,
      unknownDateCount: dateFilterResult.unknownDateCount,
      unknownDateMode: dateFilterResult.dateFilter.unknownDateMode,
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
      retryOfJobId,
      retrySource,
      retryTargets,
      runFolder: settings.runFolder,
      startedAt: settings.startedAt,
      endedAt,
      scannedItems,
      resolvedCardItems,
      resolvedItems,
      deduplicatedItems,
      deduplicatedItemSamples,
      submittedDownloads,
      submittedItems,
      parseFailures,
      qualityFailures,
      scanList,
      skippedItems,
      ...dateFilterReportFields(dateFilterResult),
      directResourceSummary,
      downloadFailures,
      skippedDuplicates,
      speedMode: settings.speedMode,
      speedLabel: settings.speedLabel,
      downloadConcurrency: settings.downloadConcurrency,
      delayMs: settings.delayMs,
      diagnostic: {
        reason: error?.message || String(error),
        stage: "retry-error"
      }
    });
    await saveJobReport(report);
    await appendJobLog({
      jobId,
      level: "error",
      source: "background",
      stage: "retry-error",
      message: error?.message || String(error),
      detail: summarizeJobReport(report)
    });
    await mergeJobStatus(jobId, {
      status: "error",
      stage: "retry-error",
      message: error?.message || String(error),
      scannedItems,
      resolvedCardItems,
      resolvedItems,
      deduplicatedItems,
      parseFailureCount: parseFailures.length,
      scanListItems: scanList.length,
      skippedItems: skippedItems.length,
      dateFilter: dateFilterResult.dateFilter,
      filteredIn: dateFilterResult.filteredIn,
      filteredOut: dateFilterResult.filteredOut,
      unknownDateCount: dateFilterResult.unknownDateCount,
      unknownDateMode: dateFilterResult.dateFilter.unknownDateMode,
      directResourceSummary,
      submittedDownloads,
      qualityFailures: qualityFailures.length,
      qualityFailureCount: qualityFailures.length,
      downloadFailureCount: downloadFailures.length,
      downloadFailures: downloadFailures.length,
      skippedDuplicates: skippedDuplicates.length,
      skippedDuplicateCount: skippedDuplicates.length,
      speedMode: settings.speedMode,
      speedLabel: settings.speedLabel,
      downloadConcurrency: settings.downloadConcurrency,
      delayMs: settings.delayMs,
      totalDurationMs: endedAt - settings.startedAt,
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
    dateFilter: current.dateFilter || current.settings?.dateFilter || normalizeDateFilterSettings(),
    filteredIn: current.filteredIn ?? 0,
    filteredOut: current.filteredOut ?? 0,
    unknownDateCount: current.unknownDateCount ?? 0,
    timeRangeSkippedItems: [],
    unknownDateSkippedItems: [],
    unknownDateIncludedItems: [],
    directResourceSummary: null,
    downloadFailures: [],
    skippedDuplicates: [],
    speedMode: current.speedMode || current.settings?.speedMode || DEFAULT_SPEED_MODE,
    speedLabel: current.speedLabel || current.settings?.speedLabel || SPEED_PRESETS[DEFAULT_SPEED_MODE].label,
    downloadConcurrency: current.downloadConcurrency || current.settings?.downloadConcurrency || SPEED_PRESETS[DEFAULT_SPEED_MODE].concurrency,
    delayMs: current.delayMs ?? current.settings?.delayMs ?? SPEED_PRESETS[DEFAULT_SPEED_MODE].delayMs
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
    dateFilter: normalizeDateFilterSettings(),
    filteredIn: 0,
    filteredOut: 0,
    unknownDateCount: 0,
    unknownDateMode: DEFAULT_UNKNOWN_DATE_MODE,
    directResourceSummary: null,
    qualityFailures: 0,
    qualityFailureCount: 0,
    downloadFailures: 0,
    downloadFailureCount: 0,
    skippedDuplicates: 0,
    skippedDuplicateCount: 0,
    speedMode: DEFAULT_SPEED_MODE,
    speedLabel: SPEED_PRESETS[DEFAULT_SPEED_MODE].label,
    downloadConcurrency: SPEED_PRESETS[DEFAULT_SPEED_MODE].concurrency,
    delayMs: SPEED_PRESETS[DEFAULT_SPEED_MODE].delayMs,
    totalDurationMs: 0,
    downloadDurationMs: 0
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

async function readLatestJobReport() {
  const result = await chrome.storage.local.get([JOB_REPORT_KEY, JOB_MANIFEST_KEY, "imageJobReport"]);
  return result[JOB_REPORT_KEY] || result.imageJobReport || result[JOB_MANIFEST_KEY] || null;
}

function createJobReport({
  jobId,
  retryOfJobId = "",
  retrySource = null,
  retryTargets = [],
  runFolder,
  startedAt,
  endedAt = null,
  scannedItems = 0,
  resolvedCardItems = 0,
  resolvedItems = 0,
  deduplicatedItems = 0,
  deduplicatedItemSamples = [],
  submittedDownloads = 0,
  submittedItems = [],
  parseFailures = [],
  qualityFailures = [],
  downloadFailures = [],
  skippedDuplicates = [],
  scanList = [],
  skippedItems = [],
  dateFilter = null,
  filteredIn = 0,
  filteredOut = 0,
  unknownDateCount = 0,
  timeRangeSkippedItems = [],
  unknownDateSkippedItems = [],
  unknownDateIncludedItems = [],
  directResourceSummary = null,
  speedMode = DEFAULT_SPEED_MODE,
  speedLabel = "",
  downloadConcurrency = SPEED_PRESETS[DEFAULT_SPEED_MODE].concurrency,
  delayMs = SPEED_PRESETS[DEFAULT_SPEED_MODE].delayMs,
  downloadDurationMs = 0,
  downloadStartedAt = null,
  downloadEndedAt = null,
  diagnostic = null
} = {}) {
  const normalizedSkippedDuplicates = normalizeSkippedDuplicateItems(skippedDuplicates);
  const normalizedDateFilter = normalizeDateFilterSettings(dateFilter, startedAt);
  const normalizedTimeRangeSkippedItems = normalizeDateFilterItems(timeRangeSkippedItems, "date-filter");
  const normalizedUnknownDateSkippedItems = normalizeDateFilterItems(unknownDateSkippedItems, "unknown-date-skip");
  const normalizedUnknownDateIncludedItems = normalizeDateFilterItems(unknownDateIncludedItems, "unknown-date-include");
  const reportStartedAt = normalizeTimestamp(startedAt) || Date.now();
  const reportEndedAt = endedAt ? normalizeTimestamp(endedAt) || Date.now() : null;
  const speed = normalizeSpeedSettings({
    speedMode,
    delayMs,
    downloadConcurrency
  });
  const normalizedDownloadStartedAt = downloadStartedAt ? normalizeTimestamp(downloadStartedAt) || null : null;
  const normalizedDownloadEndedAt = downloadEndedAt ? normalizeTimestamp(downloadEndedAt) || null : null;
  const normalizedDownloadDurationMs = Number(downloadDurationMs) || (
    normalizedDownloadStartedAt && normalizedDownloadEndedAt
      ? Math.max(normalizedDownloadEndedAt - normalizedDownloadStartedAt, 0)
      : 0
  );
  const totalDurationMs = reportEndedAt ? Math.max(reportEndedAt - reportStartedAt, 0) : 0;
  const submittedDownloadCount = Number(submittedDownloads) || 0;

  return {
    jobId: String(jobId || ""),
    retryOfJobId: String(retryOfJobId || ""),
    retrySource: sanitizeReportDiagnostic(retrySource, 3000),
    retryTargets: normalizeRetryTargetsForReport(retryTargets),
    runFolder: String(runFolder || ""),
    startedAt: reportStartedAt,
    endedAt: reportEndedAt,
    totalDurationMs,
    downloadStartedAt: normalizedDownloadStartedAt,
    downloadEndedAt: normalizedDownloadEndedAt,
    downloadDurationMs: normalizedDownloadDurationMs,
    speedMode: speed.speedMode,
    speedLabel: speedLabel || speed.speedLabel,
    downloadConcurrency: speed.concurrency,
    delayMs: speed.delayMs,
    averageDownloadsPerSecond: ratePerInterval(submittedDownloadCount, normalizedDownloadDurationMs || totalDurationMs, 1000),
    averageDownloadsPerMinute: ratePerInterval(submittedDownloadCount, normalizedDownloadDurationMs || totalDurationMs, 60000),
    scannedItems: Number(scannedItems) || 0,
    resolvedCardItems: Number(resolvedCardItems) || 0,
    resolvedItems: Number(resolvedItems) || 0,
    deduplicatedItems: Number(deduplicatedItems) || 0,
    deduplicatedItemSamples: normalizeFailureItems(deduplicatedItemSamples, "dedupe"),
    submittedDownloads: submittedDownloadCount,
    submittedItems: normalizeSubmittedDownloadItems(submittedItems),
    parseFailures: normalizeFailureItems(parseFailures, "resolve"),
    qualityFailures: normalizeFailureItems(qualityFailures, "quality"),
    downloadFailures: normalizeFailureItems(downloadFailures, "download"),
    skippedDuplicates: normalizedSkippedDuplicates,
    skippedDuplicateCount: normalizedSkippedDuplicates.length,
    scanList: normalizeScanListItems(scanList),
    skippedItems: normalizeFailureItems(skippedItems, "skip"),
    dateFilter: normalizedDateFilter,
    filteredIn: Number(filteredIn) || 0,
    filteredOut: Number(filteredOut) || 0,
    unknownDateCount: Number(unknownDateCount) || 0,
    timeRangeSkippedItems: normalizedTimeRangeSkippedItems,
    unknownDateSkippedItems: normalizedUnknownDateSkippedItems,
    unknownDateIncludedItems: normalizedUnknownDateIncludedItems,
    directResourceSummary: sanitizeReportDiagnostic(directResourceSummary, 3000),
    diagnostic: sanitizeReportDiagnostic(diagnostic)
  };
}

function summarizeJobReport(report = {}) {
  return {
    jobId: report.jobId || "",
    retryOfJobId: report.retryOfJobId || "",
    retryTargets: Array.isArray(report.retryTargets) ? report.retryTargets.length : 0,
    runFolder: report.runFolder || "",
    totalDurationMs: report.totalDurationMs || 0,
    downloadDurationMs: report.downloadDurationMs || 0,
    speedMode: report.speedMode || DEFAULT_SPEED_MODE,
    speedLabel: report.speedLabel || SPEED_PRESETS[DEFAULT_SPEED_MODE].label,
    downloadConcurrency: report.downloadConcurrency || SPEED_PRESETS[DEFAULT_SPEED_MODE].concurrency,
    delayMs: report.delayMs ?? SPEED_PRESETS[DEFAULT_SPEED_MODE].delayMs,
    averageDownloadsPerMinute: report.averageDownloadsPerMinute || 0,
    scannedItems: report.scannedItems || 0,
    resolvedCardItems: report.resolvedCardItems || 0,
    resolvedItems: report.resolvedItems || 0,
    deduplicatedItems: report.deduplicatedItems || 0,
    submittedDownloads: report.submittedDownloads || 0,
    submittedItems: Array.isArray(report.submittedItems) ? report.submittedItems.length : 0,
    skippedDuplicates: Array.isArray(report.skippedDuplicates) ? report.skippedDuplicates.length : 0,
    dateFilter: report.dateFilter || normalizeDateFilterSettings(),
    filteredIn: Number(report.filteredIn) || 0,
    filteredOut: Number(report.filteredOut) || 0,
    unknownDateCount: Number(report.unknownDateCount) || 0,
    timeRangeSkippedItems: Array.isArray(report.timeRangeSkippedItems) ? report.timeRangeSkippedItems.length : 0,
    unknownDateSkippedItems: Array.isArray(report.unknownDateSkippedItems) ? report.unknownDateSkippedItems.length : 0,
    unknownDateIncludedItems: Array.isArray(report.unknownDateIncludedItems) ? report.unknownDateIncludedItems.length : 0,
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
  const dateCandidates = normalizeDateCandidatesForReport(item);
  const dateInfo = resolveDateWithLastModifiedFallback(item, dateCandidates);

  return {
    scanIndex,
    pageOrder,
    imageKey: truncateText(item.imageKey || buildReportImageKey(item, scanIndex), 80),
    thumbnailUrl: normalizeFailureUrlSummary(item.thumbnailUrl || item.thumbnail || item.url),
    prompt: truncateText(item.prompt || item.alt || "", 240),
    date: truncateText(dateInfo.date, 80),
    dateSource: truncateText(dateInfo.dateSource, 120),
    dateCandidates,
    dateCandidatesSummary: normalizeDateCandidatesSummary(item, dateCandidates),
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

function normalizeDateCandidatesForReport(itemOrCandidates) {
  const candidates = Array.isArray(itemOrCandidates)
    ? itemOrCandidates
    : collectDateCandidatesFromReportItem(itemOrCandidates);

  if (!Array.isArray(candidates)) {
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const normalized = {
      source: truncateText(candidate.source || "", 120),
      field: truncateText(candidate.field || "", 80),
      value: truncateText(candidate.value || "", 180),
      normalizedDate: truncateText(candidate.normalizedDate || "", 80)
    };

    if (candidate.tag) {
      normalized.tag = truncateText(candidate.tag, 40);
    }
    if (Number.isFinite(candidate.depth)) {
      normalized.depth = candidate.depth;
    }

    const key = JSON.stringify(normalized);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
    if (result.length >= 40) {
      break;
    }
  }

  return result;
}

function collectDateCandidatesFromReportItem(item = {}) {
  if (!item || typeof item !== "object") {
    return [];
  }

  const diagnostic = item.diagnostic && typeof item.diagnostic === "object" ? item.diagnostic : {};
  return [
    ...(Array.isArray(item.dateCandidates) ? item.dateCandidates : []),
    ...(Array.isArray(diagnostic.dateCandidates) ? diagnostic.dateCandidates : []),
    ...(Array.isArray(diagnostic.responseDateCandidates) ? diagnostic.responseDateCandidates : []),
    ...(Array.isArray(diagnostic.fetchFailure?.dateCandidates) ? diagnostic.fetchFailure.dateCandidates : []),
    ...(Array.isArray(diagnostic.validation?.dateCandidates) ? diagnostic.validation.dateCandidates : []),
    ...(Array.isArray(diagnostic.diagnostic?.dateCandidates) ? diagnostic.diagnostic.dateCandidates : []),
    ...(Array.isArray(diagnostic.diagnostic?.fetchFailure?.dateCandidates) ? diagnostic.diagnostic.fetchFailure.dateCandidates : []),
    ...(Array.isArray(diagnostic.diagnostic?.validation?.dateCandidates) ? diagnostic.diagnostic.validation.dateCandidates : [])
  ];
}

function normalizeDateCandidatesSummary(item = {}, dateCandidates = null) {
  const existing = truncateText(item.dateCandidatesSummary || "", 1000);
  if (existing) {
    return existing;
  }

  return summarizeDateCandidatesForReport(dateCandidates || normalizeDateCandidatesForReport(item));
}

function summarizeDateCandidatesForReport(candidates, maxEntries = 12) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return "";
  }

  return candidates.slice(0, maxEntries).map((candidate) => {
    const source = [candidate.source, candidate.field].filter(Boolean).join(":") || "date";
    const date = candidate.normalizedDate || "?";
    return `${source}=${date} <= ${truncateText(candidate.value || "", 64)}`;
  }).join(" | ");
}

const RESPONSE_LAST_MODIFIED_DATE_SOURCE = "response-header.last-modified";

function resolveDateWithLastModifiedFallback(item = {}, dateCandidates = null) {
  const existingDate = String(item.date || "");
  if (existingDate) {
    return {
      date: existingDate,
      dateSource: String(item.dateSource || "")
    };
  }

  const fallback = findResponseLastModifiedDateCandidate(dateCandidates || normalizeDateCandidatesForReport(item));
  return {
    date: fallback?.normalizedDate || "",
    dateSource: fallback ? RESPONSE_LAST_MODIFIED_DATE_SOURCE : String(item.dateSource || "")
  };
}

function findResponseLastModifiedDateCandidate(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .find((candidate) => isResponseLastModifiedDateCandidate(candidate)) || null;
}

function isResponseLastModifiedDateCandidate(candidate = {}) {
  const source = String(candidate.source || "").toLowerCase();
  const field = String(candidate.field || "").toLowerCase();
  return Boolean(candidate.normalizedDate)
    && (
      source === RESPONSE_LAST_MODIFIED_DATE_SOURCE
      || (source === "response-header" && field === "last-modified")
    );
}

function collectDateCandidatesFromValues(...values) {
  const candidates = [];

  for (const value of values) {
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      candidates.push(...value);
      continue;
    }
    candidates.push(...collectDateCandidatesFromReportItem(value));
  }

  return normalizeDateCandidatesForReport(candidates);
}

function applyResponseLastModifiedDateFallback(image = {}, ...candidateSources) {
  const dateCandidates = collectDateCandidatesFromValues(image, ...candidateSources);
  const dateInfo = resolveDateWithLastModifiedFallback(image, dateCandidates);
  const dateCandidatesSummary = summarizeDateCandidatesForReport(dateCandidates) || image.dateCandidatesSummary || "";

  return {
    ...image,
    date: dateInfo.date,
    dateSource: dateInfo.dateSource,
    dateCandidates,
    dateCandidatesSummary
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

function normalizeSkippedDuplicateItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => normalizeSkippedDuplicateItem(item, index + 1))
    .filter(Boolean);
}

function normalizeSubmittedDownloadItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => normalizeSubmittedDownloadItem(item, index + 1))
    .filter(Boolean);
}

function normalizeSubmittedDownloadItem(item, fallbackIndex) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const index = Number(item.index || item.scanIndex || fallbackIndex || 0);
  const scanIndex = Number(item.scanIndex || index || fallbackIndex || 0);
  const pageOrder = Number(item.pageOrder || scanIndex || index || fallbackIndex || 0);
  const dateCandidates = normalizeDateCandidatesForReport(item);
  const dateInfo = resolveDateWithLastModifiedFallback(item, dateCandidates);

  return {
    index,
    scanIndex,
    pageOrder,
    imageKey: truncateText(item.imageKey || buildReportImageKey(item, index), 80),
    prompt: truncateText(item.prompt || item.alt || "", 240),
    date: truncateText(dateInfo.date, 80),
    dateSource: truncateText(dateInfo.dateSource, 120),
    dateCandidates,
    dateCandidatesSummary: normalizeDateCandidatesSummary(item, dateCandidates),
    source: truncateText(item.source || "", 80),
    sourceUrl: truncateText(item.sourceUrl || item.url || "", 1000),
    filename: truncateText(item.filename || "", 1000),
    downloadId: item.downloadId ?? null,
    reason: truncateText(item.reason || "", 120),
    stage: truncateText(item.stage || "download", 80),
    status: truncateText(item.status || "submitted", 80),
    quality: sanitizeReportDiagnostic(item.quality, 1000),
    diagnostic: sanitizeReportDiagnostic(item.diagnostic, 1500)
  };
}

function normalizeRetryTargetsForReport(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => normalizeRetryTargetForReport(item, index + 1))
    .filter(Boolean);
}

function normalizeRetryTargetForReport(item, fallbackIndex) {
  const normalized = normalizeFailureItem(item, item?.stage || "retry", fallbackIndex);
  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    retrySourceType: truncateText(item.retrySourceType || item.sourceType || "", 40),
    retryOfJobId: truncateText(item.retryOfJobId || "", 80)
  };
}

function normalizeSkippedDuplicateItem(item, fallbackIndex) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const index = Number(item.index || item.scanIndex || fallbackIndex || 0);
  const scanIndex = Number(item.scanIndex || index || fallbackIndex || 0);
  const pageOrder = Number(item.pageOrder || scanIndex || index || fallbackIndex || 0);
  const dateCandidates = normalizeDateCandidatesForReport(item);
  const dateInfo = resolveDateWithLastModifiedFallback(item, dateCandidates);

  return {
    index,
    scanIndex,
    pageOrder,
    imageKey: truncateText(item.imageKey || buildReportImageKey(item, index), 80),
    prompt: truncateText(item.prompt || item.alt || "", 240),
    date: truncateText(dateInfo.date, 80),
    dateSource: truncateText(dateInfo.dateSource, 120),
    dateCandidates,
    dateCandidatesSummary: normalizeDateCandidatesSummary(item, dateCandidates),
    sourceUrl: truncateText(item.sourceUrl || item.url || "", 1000),
    previousFilename: truncateText(item.previousFilename || "", 1000),
    previousDownloadId: item.previousDownloadId ?? null,
    previousSubmittedAt: normalizeTimestamp(item.previousSubmittedAt) || null,
    reason: truncateText(item.reason || "skippedDuplicate", 80),
    stage: truncateText(item.stage || "history-dedupe", 80)
  };
}

function normalizeDateFilterItems(items, fallbackReason = "") {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => normalizeDateFilterItem(item, fallbackReason, index + 1))
    .filter(Boolean);
}

function normalizeDateFilterItem(item, fallbackReason = "", fallbackIndex = 0) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const index = Number(item.index || item.scanIndex || fallbackIndex || 0);
  const scanIndex = Number(item.scanIndex || index || fallbackIndex || 0);
  const pageOrder = Number(item.pageOrder || scanIndex || index || fallbackIndex || 0);
  const dateCandidates = normalizeDateCandidatesForReport(item);
  const dateInfo = resolveDateWithLastModifiedFallback(item, dateCandidates);

  return {
    index,
    scanIndex,
    pageOrder,
    imageKey: truncateText(item.imageKey || buildReportImageKey(item, index), 80),
    prompt: truncateText(item.prompt || item.alt || "", 240),
    date: truncateText(dateInfo.date, 80),
    dateSource: truncateText(dateInfo.dateSource, 120),
    dateCandidates,
    dateCandidatesSummary: normalizeDateCandidatesSummary(item, dateCandidates),
    source: truncateText(item.source || "", 80),
    sourceUrl: truncateText(item.sourceUrl || item.url || "", 1000),
    reason: truncateText(item.reason || fallbackReason || "date-filter", 120),
    stage: truncateText(item.stage || "date-filter", 80)
  };
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
  const dateCandidates = normalizeDateCandidatesForReport(item);
  const dateInfo = resolveDateWithLastModifiedFallback(item, dateCandidates);

  return {
    index,
    scanIndex,
    pageOrder,
    imageKey: truncateText(item.imageKey || buildReportImageKey(item, index), 80),
    thumbnailUrl: normalizeFailureUrlSummary(item.thumbnailUrl || item.thumbnail || item.url),
    prompt: truncateText(item.prompt || item.alt || "", 240),
    date: truncateText(dateInfo.date, 80),
    dateSource: truncateText(dateInfo.dateSource, 120),
    dateCandidates,
    dateCandidatesSummary: normalizeDateCandidatesSummary(item, dateCandidates),
    source: truncateText(item.source || "", 80),
    sourceUrl: truncateText(item.sourceUrl || item.url || "", 1000),
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
    "sourceUrl",
    "url",
    "prompt",
    "alt",
    "date",
    "dateSource",
    "dateCandidates",
    "dateCandidatesSummary",
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
    sourceUrl: image.sourceUrl || image.url || "",
    prompt: image.prompt || image.alt || "",
    date: image.date || "",
    dateSource: image.dateSource || "",
    dateCandidates: image.dateCandidates || [],
    dateCandidatesSummary: image.dateCandidatesSummary || "",
    source: image.source || "",
    reason,
    stage,
    diagnostic,
    quality
  }, stage, index);
}

function buildRetryTargetsFromReport(report = {}) {
  const retryOfJobId = String(report.jobId || "");
  const targets = [];

  appendRetryTargets(targets, report.parseFailures, "parse", retryOfJobId);
  appendRetryTargets(targets, report.downloadFailures, "download", retryOfJobId);

  const seen = new Set();
  return targets.filter((target) => {
    const key = target.imageKey || `${target.retrySourceType}:${target.scanIndex}:${target.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function appendRetryTargets(targets, items, retrySourceType, retryOfJobId) {
  const normalizedItems = normalizeFailureItems(items, retrySourceType === "parse" ? "resolve" : "download");

  for (const item of normalizedItems) {
    targets.push({
      ...item,
      retrySourceType,
      retryOfJobId,
      originalStage: item.stage || "",
      originalReason: item.reason || ""
    });
  }
}

function createRetrySourceSummary(report = {}, retryTargets = []) {
  const parseFailureCount = Array.isArray(report.parseFailures) ? report.parseFailures.length : 0;
  const downloadFailureCount = Array.isArray(report.downloadFailures) ? report.downloadFailures.length : 0;
  const qualityFailureCount = Array.isArray(report.qualityFailures) ? report.qualityFailures.length : 0;

  return {
    retryOfJobId: String(report.jobId || ""),
    sourceRunFolder: String(report.runFolder || ""),
    sourceStartedAt: report.startedAt || null,
    sourceEndedAt: report.endedAt || null,
    parseFailureCount,
    downloadFailureCount,
    qualityFailureCount,
    qualityFailuresSkipped: qualityFailureCount,
    retryTargetCount: retryTargets.length,
    retryPolicy: "parseFailures and downloadFailures only; qualityFailures are not retried by default",
    historyPolicy: "downloadHistory is checked by imageKey; filenames are not used for resume or dedupe"
  };
}

function selectRetryImages({
  images,
  parseFailures,
  retryTargets,
  retryOfJobId,
  downloadHistory,
  downloadMode
} = {}) {
  const targets = normalizeRetryTargetsForReport(retryTargets);
  const targetMatches = new Map();
  const selectedImages = [];
  const selectedParseFailures = [];
  const skippedDuplicates = [];
  const missingTargets = [];
  const shouldSkipHistory = normalizeDownloadMode(downloadMode) !== "all";
  const selectedImageKeys = new Set();

  for (const [index, image] of (Array.isArray(images) ? images : []).entries()) {
    const target = findRetryTargetForItem(image, targets);
    if (!target) {
      continue;
    }

    const imageKey = buildImageKey(image);
    if (selectedImageKeys.has(imageKey)) {
      continue;
    }

    selectedImageKeys.add(imageKey);
    markRetryTargetMatched(targetMatches, target, "resolved");
    selectedImages.push({
      ...image,
      retryOfJobId,
      retrySourceType: target.retrySourceType || "",
      retrySourceImageKey: target.imageKey || "",
      retrySourceStage: target.stage || "",
      retrySourceReason: target.reason || "",
      retrySelectionIndex: index + 1
    });
  }

  for (const failure of (Array.isArray(parseFailures) ? parseFailures : [])) {
    const target = findRetryTargetForItem(failure, targets);
    if (!target) {
      continue;
    }

    markRetryTargetMatched(targetMatches, target, "parse-failed");
    selectedParseFailures.push(buildRetryFailureItem({
      target,
      failure,
      reason: failure.reason || "retry-parse-failed",
      stage: failure.stage || "resolve",
      retryOfJobId
    }));
  }

  for (const target of targets) {
    if (targetMatches.has(retryTargetIdentity(target))) {
      continue;
    }

    const previousHistoryEntry = shouldSkipHistory && target.imageKey
      ? downloadHistory?.[target.imageKey]
      : null;
    if (previousHistoryEntry) {
      skippedDuplicates.push(createSkippedDuplicateItem({
        index: target.index,
        scanIndex: target.scanIndex,
        pageOrder: target.pageOrder,
        image: target,
        imageKey: target.imageKey,
        previous: previousHistoryEntry
      }));
      markRetryTargetMatched(targetMatches, target, "history");
      continue;
    }

    missingTargets.push(target);
    selectedParseFailures.push(buildRetryFailureItem({
      target,
      reason: "retry-target-not-resolved-in-current-scan",
      stage: "retry-select",
      retryOfJobId
    }));
  }

  return {
    images: selectedImages,
    parseFailures: selectedParseFailures,
    skippedDuplicates,
    missingTargets
  };
}

function findRetryTargetForItem(item, retryTargets) {
  const keys = retryMatchKeys(item);
  for (const target of retryTargets) {
    if (keys.has(target.imageKey)) {
      return target;
    }
  }

  return retryTargets.find((target) => isLikelySameRetryItem(item, target)) || null;
}

function retryMatchKeys(item = {}) {
  const keys = new Set();
  for (const key of [
    item.imageKey,
    item.retrySourceImageKey,
    item.initialImageKey,
    item.previousImageKey,
    ...(Array.isArray(item.retryImageKeys) ? item.retryImageKeys : [])
  ]) {
    const normalized = sanitizeProvidedImageKey(key);
    if (normalized) {
      keys.add(normalized);
    }
  }

  const builtKey = buildImageKey(item);
  if (builtKey) {
    keys.add(builtKey);
  }

  return keys;
}

function isLikelySameRetryItem(item = {}, target = {}) {
  const itemScanIndex = Number(item.scanIndex || item.index || 0);
  const targetScanIndex = Number(target.scanIndex || target.index || 0);
  if (!itemScanIndex || !targetScanIndex || itemScanIndex !== targetScanIndex) {
    return false;
  }

  const itemDate = normalizeKeyText(item.date || "");
  const targetDate = normalizeKeyText(target.date || "");
  if (itemDate && targetDate && itemDate !== targetDate) {
    return false;
  }

  const itemPrompt = normalizeKeyText(item.prompt || item.alt || "").slice(0, 80);
  const targetPrompt = normalizeKeyText(target.prompt || target.alt || "").slice(0, 80);
  return !itemPrompt || !targetPrompt || itemPrompt === targetPrompt;
}

function markRetryTargetMatched(targetMatches, target, value) {
  targetMatches.set(retryTargetIdentity(target), value);
}

function retryTargetIdentity(target = {}) {
  return target.imageKey || `${target.retrySourceType || "retry"}:${target.scanIndex || target.index || 0}:${target.reason || ""}`;
}

function buildRetryFailureItem({ target = {}, failure = null, reason = "", stage = "retry-select", retryOfJobId = "" } = {}) {
  return normalizeFailureItem({
    index: failure?.index || target.index,
    scanIndex: failure?.scanIndex || target.scanIndex,
    pageOrder: failure?.pageOrder || target.pageOrder,
    imageKey: failure?.imageKey || target.imageKey,
    thumbnailUrl: failure?.thumbnailUrl || target.thumbnailUrl,
    prompt: failure?.prompt || target.prompt || "",
    date: failure?.date || target.date || "",
    dateSource: failure?.dateSource || target.dateSource || "",
    dateCandidates: failure?.dateCandidates || target.dateCandidates || [],
    dateCandidatesSummary: failure?.dateCandidatesSummary || target.dateCandidatesSummary || "",
    source: failure?.source || target.source || "",
    sourceUrl: failure?.sourceUrl || target.sourceUrl || "",
    reason,
    stage,
    diagnostic: {
      retryOfJobId,
      retrySourceType: target.retrySourceType || "",
      retrySourceImageKey: target.imageKey || "",
      retrySourceStage: target.originalStage || target.stage || "",
      retrySourceReason: target.originalReason || target.reason || "",
      failureDiagnostic: failure?.diagnostic || null
    },
    quality: failure?.quality || target.quality || null
  }, stage, target.index);
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
  const rawImages = Array.isArray(payload?.images) ? payload.images : [];
  const folder = sanitizePathSegment(payload?.folder || DEFAULT_FOLDER, DEFAULT_FOLDER);
  const accountLabel = normalizeAccountLabel(payload?.accountLabel);
  const startedAt = normalizeTimestamp(payload?.startedAt) || Date.now();
  const jobId = payload?.jobId || "";
  const speed = normalizeSpeedSettings(payload);
  const dateFilter = normalizeDateFilterSettings(payload?.dateFilter, startedAt);
  const images = rawImages;
  const dateFilterAccumulator = createDownloadDateFilterAccumulator(dateFilter);
  const runContext = buildRunContext({
    folder,
    accountLabel,
    startedAt,
    jobId,
    runId: payload?.runId
  });
  const { runId, runFolder } = runContext;
  const delayMs = speed.delayMs;
  const concurrency = speed.concurrency;
  const tabId = Number(payload?.tabId || 0);
  const downloadMode = normalizeDownloadMode(payload?.downloadMode);
  const shouldSkipHistory = downloadMode !== "all";
  const downloadHistory = await readDownloadHistory();
  const downloadStartedAt = Date.now();

  let started = 0;
  const failures = [];
  const qualityFailures = [];
  const skippedDuplicates = [];
  const submittedItems = [];

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
      total: images.length,
      downloadMode,
      dateFilter: {
        ...summarizeDateFilterResult(dateFilterAccumulator),
        timing: "after-download-prepare"
      },
      historyItems: Object.keys(downloadHistory).length,
      speedMode: speed.speedMode,
      speedLabel: speed.speedLabel,
      concurrency,
      delayMs
    }
  });

  const results = await runDownloadQueue(
    images.map((image, index) => ({
      image,
      itemNumber: index + 1
    })),
    concurrency,
    (item) => processDownloadImageItem({
      ...item,
      total: images.length,
      tabId,
      jobId,
      shouldSkipHistory,
      downloadHistory,
      dateFilter,
      runContext,
      runId,
      runFolder
    }),
    delayMs
  );

  for (const result of results.sort((left, right) => left.itemNumber - right.itemNumber)) {
    started += result.started || 0;
    failures.push(...(result.failures || []));
    qualityFailures.push(...(result.qualityFailures || []));
    skippedDuplicates.push(...(result.skippedDuplicates || []));
    submittedItems.push(...(result.submittedItems || []));
    accumulateDownloadDateFilterResult(dateFilterAccumulator, result);

    if (result.historyEntry && result.imageKey) {
      downloadHistory[result.imageKey] = result.historyEntry;
    }
  }

  if (started > 0) {
    await saveDownloadHistory(downloadHistory);
  }

  const downloadEndedAt = Date.now();
  const durationMs = Math.max(downloadEndedAt - downloadStartedAt, 0);
  const dateFilterResult = finalizeDownloadDateFilterResult(dateFilterAccumulator);

  return {
    started,
    failures,
    submittedDownloads: started,
    submittedItems,
    qualityFailures,
    downloadFailures: failures,
    skippedDuplicates,
    dateFilterResult,
    timeRangeSkippedItems: dateFilterResult.timeRangeSkippedItems,
    unknownDateSkippedItems: dateFilterResult.unknownDateSkippedItems,
    unknownDateIncludedItems: dateFilterResult.unknownDateIncludedItems,
    runId,
    runFolder,
    accountLabel,
    speedMode: speed.speedMode,
    speedLabel: speed.speedLabel,
    concurrency,
    delayMs,
    startedAt: downloadStartedAt,
    endedAt: downloadEndedAt,
    durationMs,
    averageDownloadsPerSecond: ratePerInterval(started, durationMs, 1000),
    averageDownloadsPerMinute: ratePerInterval(started, durationMs, 60000)
  };

}

async function runDownloadQueue(items, concurrency, worker, delayMs) {
  const results = new Array(items.length);
  const workerCount = Math.min(Math.max(Number(concurrency) || 1, 1), MAX_DOWNLOAD_CONCURRENCY, items.length || 1);
  let nextIndex = 0;

  async function consume() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);

      if (delayMs > 0 && nextIndex < items.length) {
        await sleep(delayMs);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, consume));
  return results.filter(Boolean);
}

async function processDownloadImageItem({
  image,
  itemNumber,
  total,
  tabId,
  jobId,
  shouldSkipHistory,
  downloadHistory,
  dateFilter,
  runContext,
  runId,
  runFolder
}) {
  const result = {
    itemNumber,
    started: 0,
    failures: [],
    qualityFailures: [],
    skippedDuplicates: [],
    submittedItems: [],
    dateFilterIncluded: 0,
    unknownDateCount: 0,
    timeRangeSkippedItems: [],
    unknownDateSkippedItems: [],
    unknownDateIncludedItems: [],
    imageKey: "",
    historyEntry: null
  };

  if (!image?.url) {
    return result;
  }

  const scanIndex = normalizedScanIndex(image, itemNumber);
  const pageOrder = Number(image.pageOrder || scanIndex || itemNumber);
  const imageKey = buildImageKey(image);
  const shortHash = imageKeyToShortHash(imageKey);
  const urlSummary = summarizeDownloadUrl(image.url);
  result.imageKey = imageKey;

  const previousHistoryEntry = downloadHistory[imageKey] || null;
  if (shouldSkipHistory && previousHistoryEntry) {
    const skippedDuplicate = createSkippedDuplicateItem({
      index: itemNumber,
      scanIndex,
      pageOrder,
      image,
      imageKey,
      previous: previousHistoryEntry
    });
    result.skippedDuplicates.push(skippedDuplicate);
    result.dateFilterIncluded = 1;
    await appendJobLog({
      jobId,
      level: "info",
      source: "background",
      stage: "history-dedupe",
      message: "skippedDuplicate: image already exists in downloadHistory",
      detail: {
        index: itemNumber,
        scanIndex,
        pageOrder,
        total,
        imageKey,
        shortHash,
        source: image.source || "",
        runFolder,
        previousFilename: previousHistoryEntry.filename || "",
        previousDownloadId: previousHistoryEntry.downloadId ?? null,
        sourceUrl: image.sourceUrl || image.url || ""
      }
    });

    return result;
  }

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
      total,
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
      total
    });
    const targetDateCandidates = collectDateCandidatesFromValues(target);
    const imageWithDateFallback = applyResponseLastModifiedDateFallback(image, targetDateCandidates);
    const dateFilterDecision = evaluatePreparedImageDateFilter({
      image: imageWithDateFallback,
      dateFilter,
      index: itemNumber
    });
    applyPreparedImageDateFilterDecision(result, dateFilterDecision);

    if (dateFilterDecision.action !== "include") {
      await appendJobLog({
        jobId,
        level: "info",
        source: "background",
        stage: "date-filter",
        message: dateFilterDecision.action === "skip-time-range"
          ? "date-filter-skip: prepared image is outside selected range"
          : "date-filter-skip: prepared image date is still unknown",
        detail: {
          index: itemNumber,
          scanIndex,
          pageOrder,
          total,
          imageKey,
          shortHash,
          source: image.source || "",
          runFolder,
          date: imageWithDateFallback.date || "",
          dateSource: imageWithDateFallback.dateSource || "",
          reason: dateFilterDecision.reason,
          dateFilter: dateFilterDecision.dateFilter,
          dateCandidatesSummary: imageWithDateFallback.dateCandidatesSummary || ""
        }
      });

      return result;
    }

    if (!target.ok) {
      const failureItem = buildDownloadFailureItem({
        index: itemNumber,
        scanIndex,
        pageOrder,
        image: imageWithDateFallback,
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
        result.qualityFailures.push(failureItem);
      } else {
        result.failures.push(failureItem);
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
          total,
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

      return result;
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
        total,
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
      target.extension || extensionFromMimeType(target.mimeType) || guessExtension(imageWithDateFallback.url)
    );
    const baseName = buildBaseName(imageWithDateFallback, itemNumber, shortHash, runContext.dateSegment);
    const filename = `${runFolder}/${baseName}.${extension}`;
    const submitted = await submitImageDownload({
      tabId,
      jobId,
      image: imageWithDateFallback,
      target,
      filename,
      imageKey,
      shortHash,
      runFolder,
      index: itemNumber,
      total
    });

    if (!submitted.ok) {
      result.failures.push(buildDownloadFailureItem({
        index: itemNumber,
        scanIndex,
        pageOrder,
        image: imageWithDateFallback,
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
          total,
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
      return result;
    }

    result.started = 1;
    result.submittedItems.push(createSubmittedDownloadItem({
      index: itemNumber,
      scanIndex,
      pageOrder,
      image: imageWithDateFallback,
      imageKey,
      filename,
      downloadId: submitted.downloadId,
      sourceUrl: target.sourceUrl || imageWithDateFallback.sourceUrl || imageWithDateFallback.url || "",
      quality: target.quality || null,
      diagnostic: target.diagnostic || null,
      dateCandidates: targetDateCandidates
    }));
    result.historyEntry = createDownloadHistoryEntry({
      image: imageWithDateFallback,
      imageKey,
      filename,
      downloadId: submitted.downloadId,
      sourceUrl: target.sourceUrl || imageWithDateFallback.sourceUrl || imageWithDateFallback.url || "",
      submittedAt: Date.now()
    });
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
        total,
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
        total,
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
    result.failures.push(buildDownloadFailureItem({
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
        total,
        imageKey,
        shortHash,
        source: image.source || "",
        runFolder,
        reason,
        url: urlSummary
      }
    });
  }

  return result;
}

async function readDownloadHistory() {
  const result = await chrome.storage.local.get(DOWNLOAD_HISTORY_KEY);
  return normalizeDownloadHistory(result[DOWNLOAD_HISTORY_KEY]);
}

async function saveDownloadHistory(history) {
  await chrome.storage.local.set({
    [DOWNLOAD_HISTORY_KEY]: normalizeDownloadHistory(history)
  });
}

function normalizeDownloadHistory(value) {
  const entries = Array.isArray(value)
    ? value
    : Object.values(value && typeof value === "object" ? value : {});
  const history = {};

  for (const item of entries) {
    const normalized = normalizeDownloadHistoryEntry(item);
    if (normalized) {
      history[normalized.imageKey] = normalized;
    }
  }

  return history;
}

function normalizeDownloadHistoryEntry(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const imageKey = sanitizeProvidedImageKey(item.imageKey);
  if (!imageKey) {
    return null;
  }

  return {
    imageKey,
    filename: String(item.filename || ""),
    downloadId: item.downloadId ?? null,
    date: String(item.date || ""),
    dateSource: String(item.dateSource || ""),
    prompt: String(item.prompt || ""),
    sourceUrl: String(item.sourceUrl || ""),
    submittedAt: normalizeTimestamp(item.submittedAt) || Date.now(),
    completedAt: item.completedAt ? normalizeTimestamp(item.completedAt) || null : null
  };
}

function createDownloadHistoryEntry({ image = {}, imageKey = "", filename = "", downloadId = null, sourceUrl = "", submittedAt = Date.now() } = {}) {
  const dateInfo = resolveDateWithLastModifiedFallback(image);
  return normalizeDownloadHistoryEntry({
    imageKey,
    filename,
    downloadId,
    date: dateInfo.date,
    dateSource: dateInfo.dateSource,
    prompt: image.prompt || image.alt || "",
    sourceUrl,
    submittedAt
  });
}

function createSubmittedDownloadItem({ index, scanIndex, pageOrder, image = {}, imageKey = "", filename = "", downloadId = null, sourceUrl = "", quality = null, diagnostic = null, dateCandidates = [] } = {}) {
  const mergedDateCandidates = [
    ...(Array.isArray(image.dateCandidates) ? image.dateCandidates : []),
    ...(Array.isArray(dateCandidates) ? dateCandidates : [])
  ];
  const mergedDateCandidatesSummary = summarizeDateCandidatesForReport(normalizeDateCandidatesForReport(mergedDateCandidates));
  return normalizeSubmittedDownloadItem({
    index,
    scanIndex,
    pageOrder,
    imageKey,
    prompt: image.prompt || image.alt || "",
    date: image.date || "",
    dateSource: image.dateSource || "",
    dateCandidates: mergedDateCandidates,
    dateCandidatesSummary: mergedDateCandidatesSummary || image.dateCandidatesSummary || "",
    source: image.source || "",
    sourceUrl,
    filename,
    downloadId,
    stage: "download",
    status: "submitted",
    reason: "",
    quality,
    diagnostic
  }, index);
}

function createSkippedDuplicateItem({ index, scanIndex, pageOrder, image = {}, imageKey = "", previous = {} } = {}) {
  return normalizeSkippedDuplicateItem({
    index,
    scanIndex,
    pageOrder,
    imageKey,
    prompt: image.prompt || image.alt || "",
    date: image.date || "",
    dateSource: image.dateSource || "",
    dateCandidates: image.dateCandidates || [],
    dateCandidatesSummary: image.dateCandidatesSummary || "",
    sourceUrl: image.sourceUrl || image.url || "",
    previousFilename: previous.filename || "",
    previousDownloadId: previous.downloadId ?? null,
    previousSubmittedAt: previous.submittedAt || null,
    reason: "skippedDuplicate",
    stage: "history-dedupe"
  }, index);
}

async function resolveDownloadTarget({ tabId, jobId, image, index, total }) {
  const prepared = await prepareImageInContent({
    tabId,
    jobId,
    image,
    index,
    total
  });

  return {
    ...requireDownloadTargetQuality(prepared, image),
    qualityChecked: true
  };
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
      downloadUrlKind: target.downloadUrlKind || "direct",
      quality: target.quality || null
    };
  } catch (error) {
    if (target.downloadUrlKind !== "blob") {
      return {
        ok: false,
        reason: error?.message || String(error),
        quality: target.quality || null
      };
    }

    const fallback = await getPreparedImageDataUrl(tabId, target.downloadUrl);
    if (!fallback.ok) {
      return {
        ok: false,
        reason: `${error?.message || String(error)}; data-url-fallback: ${fallback.reason}`,
        quality: target.quality || null
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
        downloadUrlKind: "data",
        quality: target.quality || null
      };
    } catch (fallbackError) {
      return {
        ok: false,
        reason: `${error?.message || String(error)}; data-url-fallback: ${fallbackError?.message || String(fallbackError)}`,
        quality: target.quality || null
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
  const stableId = stableImageIdFromImage(image);
  if (stableId) {
    return `img-${shortHashText(stableId, 16)}`;
  }

  const originalUrl = canonicalizeOriginalImageUrlForKey(
    image?.url || image?.sourceUrl || image?.originalUrl || image?.downloadUrl || ""
  );
  if (originalUrl) {
    return `img-${shortHashText(`url:${originalUrl}`, 16)}`;
  }

  const providedKey = sanitizeProvidedImageKey(image?.imageKey);
  if (providedKey) {
    return providedKey;
  }

  const keyInput = [
    normalizeKeyText(image?.prompt || image?.alt || ""),
    sanitizeDateSegment(image?.date || ""),
    canonicalizeImageUrlForKey(image?.thumbnailUrl || "")
  ].filter(Boolean).join("|") || "image";

  return `img-${shortHashText(`fallback:${keyInput}`, 16)}`;
}

function stableImageIdFromImage(image = {}) {
  const explicitIds = [
    image.estuaryId,
    image.fileId,
    image.fileID,
    image.file_id
  ];
  for (const value of explicitIds) {
    const id = normalizeStableImageId(value);
    if (id) {
      return id;
    }
  }

  const urls = [
    image.url,
    image.sourceUrl,
    image.originalUrl,
    image.downloadUrl,
    image.thumbnailUrl
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

function canonicalizeOriginalImageUrlForKey(url) {
  if (!url) {
    return "";
  }

  const withoutThumbnail = removeThumbnailMarkerFromUrl(url) || url;
  if (sourceUrlLooksLikeThumbnail(withoutThumbnail) && !removeThumbnailMarkerFromUrl(withoutThumbnail)) {
    return "";
  }

  return canonicalizeImageUrlForKey(withoutThumbnail);
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

function removeThumbnailMarkerFromUrl(url) {
  try {
    const parsed = new URL(url);
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

    return changed ? parsed.href : "";
  } catch {
    return "";
  }
}

function normalizedEstuaryContentId(url) {
  const id = estuaryContentInfo(url)?.id || "";
  return id.replace(/#thumbnail$/i, "");
}

function normalizedFileId(url) {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
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

function normalizeDateFilterSettings(value = {}, now = Date.now()) {
  const source = value && typeof value === "object" ? value : {};
  const rawMode = String(source.mode || source.dateFilterMode || DEFAULT_DATE_FILTER_MODE).toLowerCase();
  const mode = rawMode === "today" || rawMode === "custom" ? rawMode : DEFAULT_DATE_FILTER_MODE;
  const unknownDateMode = normalizeUnknownDateMode(source.unknownDateMode || source.unknownDates || source.includeUnknownDates);
  const timestamp = normalizeTimestamp(now) || Date.now();
  let start = null;
  let end = null;

  if (mode === "today") {
    const today = new Date(timestamp);
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0).getTime();
    end = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999).getTime();
  } else if (mode === "custom") {
    start = parseDateFilterBoundary(source.start || source.startDate || source.customStart, "start");
    end = parseDateFilterBoundary(source.end || source.endDate || source.customEnd, "end");
  }

  if (start !== null && end !== null && start > end) {
    const previousStart = start;
    start = end;
    end = previousStart;
  }

  return {
    mode,
    unknownDateMode,
    start,
    end,
    startIso: start !== null ? new Date(start).toISOString() : "",
    endIso: end !== null ? new Date(end).toISOString() : "",
    startLocal: start !== null ? formatLocalDateTime(start) : "",
    endLocal: end !== null ? formatLocalDateTime(end) : "",
    timezoneOffsetMinutes: new Date(timestamp).getTimezoneOffset()
  };
}

function normalizeUnknownDateMode(value) {
  if (value === true) {
    return "include";
  }
  if (value === false) {
    return "skip";
  }

  return String(value || DEFAULT_UNKNOWN_DATE_MODE).toLowerCase() === "include"
    ? "include"
    : DEFAULT_UNKNOWN_DATE_MODE;
}

function parseDateFilterBoundary(value, boundary = "start") {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const dateOnly = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const date = boundary === "end"
      ? new Date(year, month, day, 23, 59, 59, 999)
      : new Date(year, month, day, 0, 0, 0, 0);
    const timestamp = date.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const localDateTime = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?$/);
  if (localDateTime) {
    const hasSeconds = localDateTime[6] !== undefined;
    const date = new Date(
      Number(localDateTime[1]),
      Number(localDateTime[2]) - 1,
      Number(localDateTime[3]),
      Number(localDateTime[4]),
      Number(localDateTime[5] || 0),
      hasSeconds ? Number(localDateTime[6]) : (boundary === "end" ? 59 : 0),
      boundary === "end" ? 999 : 0
    );
    const timestamp = date.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyDateFilterResult(dateFilter) {
  const normalizedDateFilter = normalizeDateFilterSettings(dateFilter);
  return {
    images: [],
    dateFilter: normalizedDateFilter,
    filteredIn: 0,
    filteredOut: 0,
    unknownDateCount: 0,
    timeRangeSkippedItems: [],
    unknownDateSkippedItems: [],
    unknownDateIncludedItems: []
  };
}

function createDownloadDateFilterAccumulator(dateFilter) {
  return emptyDateFilterResult(dateFilter);
}

function accumulateDownloadDateFilterResult(accumulator, result = {}) {
  if (!accumulator || typeof accumulator !== "object") {
    return;
  }

  accumulator.filteredIn += Number(result.dateFilterIncluded || 0) || 0;
  accumulator.unknownDateCount += Number(result.unknownDateCount || 0) || 0;
  accumulator.timeRangeSkippedItems.push(...(Array.isArray(result.timeRangeSkippedItems) ? result.timeRangeSkippedItems : []));
  accumulator.unknownDateSkippedItems.push(...(Array.isArray(result.unknownDateSkippedItems) ? result.unknownDateSkippedItems : []));
  accumulator.unknownDateIncludedItems.push(...(Array.isArray(result.unknownDateIncludedItems) ? result.unknownDateIncludedItems : []));
  accumulator.filteredOut = accumulator.timeRangeSkippedItems.length + accumulator.unknownDateSkippedItems.length;
}

function finalizeDownloadDateFilterResult(accumulator) {
  const result = accumulator && typeof accumulator === "object"
    ? accumulator
    : emptyDateFilterResult();

  return {
    ...result,
    filteredIn: Number(result.filteredIn) || 0,
    filteredOut: (Array.isArray(result.timeRangeSkippedItems) ? result.timeRangeSkippedItems.length : 0)
      + (Array.isArray(result.unknownDateSkippedItems) ? result.unknownDateSkippedItems.length : 0),
    unknownDateCount: Number(result.unknownDateCount) || 0,
    timeRangeSkippedItems: Array.isArray(result.timeRangeSkippedItems) ? result.timeRangeSkippedItems : [],
    unknownDateSkippedItems: Array.isArray(result.unknownDateSkippedItems) ? result.unknownDateSkippedItems : [],
    unknownDateIncludedItems: Array.isArray(result.unknownDateIncludedItems) ? result.unknownDateIncludedItems : []
  };
}

function evaluatePreparedImageDateFilter({ image = {}, dateFilter, index = 0 } = {}) {
  const normalizedDateFilter = normalizeDateFilterSettings(dateFilter);
  const imageTimestamp = parseImageDateTimestamp(image?.date);

  if (imageTimestamp === null) {
    const shouldSkipUnknown = normalizedDateFilter.mode !== DEFAULT_DATE_FILTER_MODE
      && normalizedDateFilter.unknownDateMode === "skip";
    const item = createDateFilterItem({
      image,
      index,
      reason: shouldSkipUnknown ? "unknown-date-skipped" : "unknown-date-included"
    });

    return {
      action: shouldSkipUnknown ? "skip-unknown" : "include",
      reason: shouldSkipUnknown ? "unknown-date-skipped" : "unknown-date-included",
      dateFilter: normalizedDateFilter,
      dateFilterIncluded: shouldSkipUnknown ? 0 : 1,
      unknownDateCount: 1,
      unknownDateSkippedItem: shouldSkipUnknown ? item : null,
      unknownDateIncludedItem: shouldSkipUnknown ? null : item
    };
  }

  if (isImageTimestampInDateFilter(imageTimestamp, normalizedDateFilter)) {
    return {
      action: "include",
      reason: "inside-date-range",
      dateFilter: normalizedDateFilter,
      dateFilterIncluded: 1,
      unknownDateCount: 0
    };
  }

  return {
    action: "skip-time-range",
    reason: "outside-date-range",
    dateFilter: normalizedDateFilter,
    dateFilterIncluded: 0,
    unknownDateCount: 0,
    timeRangeSkippedItem: createDateFilterItem({
      image,
      index,
      reason: "outside-date-range"
    })
  };
}

function applyPreparedImageDateFilterDecision(result, decision = {}) {
  if (!result || typeof result !== "object") {
    return;
  }

  result.dateFilterIncluded += Number(decision.dateFilterIncluded || 0) || 0;
  result.unknownDateCount += Number(decision.unknownDateCount || 0) || 0;

  if (decision.timeRangeSkippedItem) {
    result.timeRangeSkippedItems.push(decision.timeRangeSkippedItem);
  }
  if (decision.unknownDateSkippedItem) {
    result.unknownDateSkippedItems.push(decision.unknownDateSkippedItem);
  }
  if (decision.unknownDateIncludedItem) {
    result.unknownDateIncludedItems.push(decision.unknownDateIncludedItem);
  }
}

function filterImagesByDate(images, dateFilter) {
  const normalizedDateFilter = normalizeDateFilterSettings(dateFilter);
  const filteredImages = [];
  const timeRangeSkippedItems = [];
  const unknownDateSkippedItems = [];
  const unknownDateIncludedItems = [];
  const list = Array.isArray(images) ? images : [];
  let unknownDateCount = 0;

  for (const [index, image] of list.entries()) {
    const itemNumber = index + 1;
    const imageWithDateFallback = applyResponseLastModifiedDateFallback(image);
    const decision = evaluatePreparedImageDateFilter({
      image: imageWithDateFallback,
      dateFilter: normalizedDateFilter,
      index: itemNumber
    });

    unknownDateCount += Number(decision.unknownDateCount || 0) || 0;

    if (decision.action === "include") {
      if (decision.unknownDateIncludedItem) {
        unknownDateIncludedItems.push(decision.unknownDateIncludedItem);
      }
      filteredImages.push(imageWithDateFallback);
      continue;
    }

    if (decision.action === "skip-time-range" && decision.timeRangeSkippedItem) {
      timeRangeSkippedItems.push(decision.timeRangeSkippedItem);
      continue;
    }

    if (decision.action === "skip-unknown" && decision.unknownDateSkippedItem) {
      unknownDateSkippedItems.push(decision.unknownDateSkippedItem);
    }
  }

  return {
    images: filteredImages,
    dateFilter: normalizedDateFilter,
    filteredIn: filteredImages.length,
    filteredOut: Math.max(list.length - filteredImages.length, 0),
    unknownDateCount,
    timeRangeSkippedItems,
    unknownDateSkippedItems,
    unknownDateIncludedItems
  };
}

function parseImageDateTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const dateOnly = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) {
    const timestamp = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function isImageTimestampInDateFilter(timestamp, dateFilter) {
  if (dateFilter.mode === DEFAULT_DATE_FILTER_MODE) {
    return true;
  }
  if (dateFilter.start !== null && timestamp < dateFilter.start) {
    return false;
  }
  if (dateFilter.end !== null && timestamp > dateFilter.end) {
    return false;
  }

  return true;
}

function createDateFilterItem({ image = {}, index = 0, reason = "date-filter" } = {}) {
  const scanIndex = normalizedScanIndex(image, index);
  return normalizeDateFilterItem({
    index,
    scanIndex,
    pageOrder: Number(image.pageOrder || scanIndex || index || 0),
    imageKey: image.imageKey || buildImageKey(image),
    prompt: image.prompt || image.alt || "",
    date: image.date || "",
    dateSource: image.dateSource || "",
    dateCandidates: image.dateCandidates || [],
    dateCandidatesSummary: image.dateCandidatesSummary || "",
    source: image.source || "",
    sourceUrl: image.sourceUrl || image.url || "",
    reason,
    stage: "date-filter"
  }, reason, index);
}

function dateFilterReportFields(result) {
  const value = result && typeof result === "object" ? result : emptyDateFilterResult();
  return {
    dateFilter: value.dateFilter || normalizeDateFilterSettings(),
    filteredIn: Number(value.filteredIn) || 0,
    filteredOut: Number(value.filteredOut) || 0,
    unknownDateCount: Number(value.unknownDateCount) || 0,
    timeRangeSkippedItems: normalizeDateFilterItems(value.timeRangeSkippedItems, "outside-date-range"),
    unknownDateSkippedItems: normalizeDateFilterItems(value.unknownDateSkippedItems, "unknown-date-skipped"),
    unknownDateIncludedItems: normalizeDateFilterItems(value.unknownDateIncludedItems, "unknown-date-included")
  };
}

function summarizeDateFilterResult(result) {
  const fields = dateFilterReportFields(result);
  return {
    dateFilter: fields.dateFilter,
    filteredIn: fields.filteredIn,
    filteredOut: fields.filteredOut,
    unknownDateCount: fields.unknownDateCount,
    timeRangeSkipped: fields.timeRangeSkippedItems.length,
    unknownDateSkipped: fields.unknownDateSkippedItems.length,
    unknownDateIncluded: fields.unknownDateIncludedItems.length
  };
}

function normalizeDownloadMode(value) {
  return String(value || "").toLowerCase() === "all" ? "all" : "new";
}

function normalizeSpeedSettings(value = {}) {
  const speedMode = normalizeSpeedMode(value.speedMode || value.mode);
  const preset = SPEED_PRESETS[speedMode] || SPEED_PRESETS[DEFAULT_SPEED_MODE];
  const rawConcurrency = Number(value.downloadConcurrency ?? value.concurrency ?? preset.concurrency);
  const rawDelayMs = Number(value.delayMs ?? preset.delayMs);
  const concurrency = clamp(
    Number.isFinite(rawConcurrency) ? rawConcurrency : preset.concurrency,
    1,
    MAX_DOWNLOAD_CONCURRENCY
  );
  const delayMs = clamp(
    Number.isFinite(rawDelayMs) ? rawDelayMs : preset.delayMs,
    0,
    5000
  );

  return {
    speedMode,
    speedLabel: preset.label,
    concurrency,
    delayMs
  };
}

function normalizeSpeedMode(value) {
  const mode = String(value || DEFAULT_SPEED_MODE).toLowerCase();
  return Object.prototype.hasOwnProperty.call(SPEED_PRESETS, mode)
    ? mode
    : DEFAULT_SPEED_MODE;
}

function ratePerInterval(count, durationMs, intervalMs) {
  const duration = Number(durationMs) || 0;
  if (duration <= 0) {
    return 0;
  }

  return Math.round(((Number(count) || 0) * intervalMs / duration) * 100) / 100;
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

function formatLocalDateTime(timestamp) {
  const date = new Date(timestamp);
  return `${formatLocalDate(timestamp)} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`;
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
  return Boolean(estuaryContentInfo(url)?.isEstuaryContent);
}

function estuaryContentInfo(url) {
  try {
    const parsed = new URL(url);
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
