const form = document.querySelector("#download-form");
const startButton = document.querySelector("#start");
const statusEl = document.querySelector("#status");
const logListEl = document.querySelector("#log-list");
const exportCsvButton = document.querySelector("#export-csv");
const retryFailedButton = document.querySelector("#retry-failed");
const copyFailuresButton = document.querySelector("#copy-failures");
const copyLogsButton = document.querySelector("#copy-logs");
const clearLogsButton = document.querySelector("#clear-logs");
const POLL_INTERVAL_MS = 1000;
const DEFAULT_SPEED_MODE = "standard";
const DEFAULT_DATE_FILTER_MODE = "none";
const DEFAULT_UNKNOWN_DATE_MODE = "skip";
const SPEED_PRESETS = {
  stable: { label: "稳定", concurrency: 1, delayMs: 400 },
  standard: { label: "标准", concurrency: 2, delayMs: 100 },
  fast: { label: "快速", concurrency: 3, delayMs: 0 }
};
const CSV_COLUMNS = [
  "jobId",
  "rowType",
  "scanIndex",
  "imageKey",
  "date",
  "dateSource",
  "dateCandidatesSummary",
  "prompt",
  "sourceUrl",
  "filename",
  "status",
  "stage",
  "reason"
];
const RESPONSE_LAST_MODIFIED_DATE_SOURCE = "response-header.last-modified";

let pollTimer = null;
let latestLogs = [];
let latestJobReport = null;
let latestJobIsBusy = false;

document.querySelectorAll('input[name="speed-mode"]').forEach((input) => {
  input.addEventListener("change", syncSpeedPresetControls);
});
document.querySelectorAll('input[name="date-filter-mode"]').forEach((input) => {
  input.addEventListener("change", syncDateFilterControls);
});

syncSpeedPresetControls();
syncDateFilterControls();
restoreSettings();
refreshJobStatus();
refreshJobReport();
refreshJobLogs();
syncReportActionButtons();
startPolling();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  setStatus("准备启动后台任务...");

  try {
    const settings = readSettings();
    validateSettings(settings);
    await chrome.storage.local.set({ settings });

    const tab = await getActiveTab();
    if (!tab?.id || !isChatGptUrl(tab.url)) {
      throw new Error("请先打开 chatgpt.com 的图片页面，再点击扩展。");
    }

    const response = await chrome.runtime.sendMessage({
      type: "START_IMAGE_JOB",
      payload: {
        tabId: tab.id,
        folder: settings.folder,
        accountLabel: settings.accountLabel,
        downloadMode: settings.downloadMode,
        dateFilter: settings.dateFilter,
        maxScrolls: settings.maxScrolls,
        speedMode: settings.speedMode,
        downloadConcurrency: settings.downloadConcurrency,
        delayMs: settings.delayMs
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "后台任务启动失败。");
    }

    renderJobStatus(response.result);
    await refreshJobLogs();
  } catch (error) {
    await recordPopupLog("error", "启动失败", {
      reason: error?.message || String(error)
    }, "start");
    setStatus(error.message || String(error), "error");
    setBusy(false);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.imageJobStatus?.newValue) {
    renderJobStatus(changes.imageJobStatus.newValue);
  }

  if (changes.imageJobLogs?.newValue) {
    renderLogs(changes.imageJobLogs.newValue);
  }

  const reportChange = changes.jobReport || changes.imageJobReport || changes.jobManifest;
  if (reportChange?.newValue) {
    latestJobReport = reportChange.newValue;
    syncReportActionButtons();
  }
});

exportCsvButton.addEventListener("click", async () => {
  try {
    const report = latestJobReport || await readLatestJobReport();
    const rows = collectJobReportCsvRows(report);
    if (!rows.length) {
      setStatus("当前没有可导出的 jobReport 清单。");
      flashButtonText(exportCsvButton, "无清单");
      return;
    }

    const csv = formatCsv(rows);
    const filename = buildCsvFilename(report);
    await downloadCsvFile(csv, filename);
    setStatus(`已导出 CSV 清单：${rows.length} 行。`, "success");
    flashButtonText(exportCsvButton, "已导出");
  } catch (error) {
    setStatus(`导出 CSV 失败：${error?.message || String(error)}`, "error");
  }
});

retryFailedButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("准备重试失败项...");

  try {
    const report = latestJobReport || await readLatestJobReport();
    if (!hasRetryableFailures(report)) {
      setStatus("当前 jobReport 没有可重试的解析失败或下载失败项。");
      flashButtonText(retryFailedButton, "无失败");
      setBusy(false);
      return;
    }

    const settings = readSettings();
    validateSettings(settings);
    await chrome.storage.local.set({ settings });

    const tab = await getActiveTab();
    if (!tab?.id || !isChatGptUrl(tab.url)) {
      throw new Error("请先打开 chatgpt.com 的图片页面，再重试失败项。");
    }

    const response = await chrome.runtime.sendMessage({
      type: "START_FAILED_ITEMS_RETRY",
      payload: {
        tabId: tab.id,
        retryOfJobId: report.jobId || "",
        folder: settings.folder,
        accountLabel: settings.accountLabel,
        downloadMode: settings.downloadMode,
        dateFilter: settings.dateFilter,
        maxScrolls: settings.maxScrolls,
        speedMode: settings.speedMode,
        downloadConcurrency: settings.downloadConcurrency,
        delayMs: settings.delayMs
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "失败项重试启动失败。");
    }

    renderJobStatus(response.result);
    await refreshJobLogs();
  } catch (error) {
    await recordPopupLog("error", "失败项重试启动失败", {
      reason: error?.message || String(error)
    }, "retry");
    setStatus(error.message || String(error), "error");
    setBusy(false);
  }
});

copyFailuresButton.addEventListener("click", async () => {
  try {
    const report = latestJobReport || await readLatestJobReport();
    const text = formatFailureReportForCopy(report);
    if (!text) {
      setStatus("当前没有失败清单可复制。");
      flashButtonText(copyFailuresButton, "无失败");
      return;
    }

    await navigator.clipboard.writeText(text);
    flashButtonText(copyFailuresButton, "已复制");
  } catch (error) {
    setStatus(`复制失败清单失败：${error?.message || String(error)}`, "error");
  }
});

copyLogsButton.addEventListener("click", async () => {
  const text = formatLogsForCopy(latestLogs);
  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    flashButtonText(copyLogsButton, "已复制");
  } catch (error) {
    setStatus(`复制日志失败：${error?.message || String(error)}`, "error");
  }
});

clearLogsButton.addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "CLEAR_IMAGE_JOB_LOGS" });
    if (!response?.ok) {
      throw new Error(response?.error || "清空日志失败。");
    }

    renderLogs([]);
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
});

async function restoreSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    return;
  }

  document.querySelector("#folder").value = settings.folder || "ChatGPT Images";
  document.querySelector("#account-label").value = settings.accountLabel || "";
  document.querySelector("#max-scrolls").value = settings.maxScrolls ?? 30;
  setSpeedMode(settings.speedMode || DEFAULT_SPEED_MODE);
  syncSpeedPresetControls();
  setDownloadMode(settings.downloadMode || "new");
  setDateFilter(settings.dateFilter || {});
  syncDateFilterControls();
}

function readSettings() {
  const speedMode = selectedSpeedMode();
  const speedPreset = speedPresetFor(speedMode);
  return {
    folder: document.querySelector("#folder").value.trim() || "ChatGPT Images",
    accountLabel: document.querySelector("#account-label").value.trim(),
    downloadMode: selectedDownloadMode(),
    dateFilter: selectedDateFilter(),
    speedMode,
    downloadConcurrency: speedPreset.concurrency,
    maxScrolls: numberInputValue("#max-scrolls", 30),
    delayMs: speedPreset.delayMs
  };
}

function selectedDownloadMode() {
  return document.querySelector('input[name="download-mode"]:checked')?.value === "all" ? "all" : "new";
}

function selectedDateFilter() {
  return {
    mode: selectedDateFilterMode(),
    start: document.querySelector("#date-start")?.value || "",
    end: document.querySelector("#date-end")?.value || "",
    unknownDateMode: selectedUnknownDateMode()
  };
}

function selectedDateFilterMode() {
  const value = document.querySelector('input[name="date-filter-mode"]:checked')?.value;
  return value === "today" || value === "custom" ? value : DEFAULT_DATE_FILTER_MODE;
}

function selectedUnknownDateMode() {
  return document.querySelector('input[name="unknown-date-mode"]:checked')?.value === "include"
    ? "include"
    : DEFAULT_UNKNOWN_DATE_MODE;
}

function selectedSpeedMode() {
  return normalizeSpeedMode(document.querySelector('input[name="speed-mode"]:checked')?.value);
}

function setDownloadMode(value) {
  const mode = value === "all" ? "all" : "new";
  const input = document.querySelector(`input[name="download-mode"][value="${mode}"]`);
  if (input) {
    input.checked = true;
  }
}

function setDateFilter(value = {}) {
  setDateFilterMode(value.mode || value.dateFilterMode || DEFAULT_DATE_FILTER_MODE);
  setUnknownDateMode(value.unknownDateMode || DEFAULT_UNKNOWN_DATE_MODE);
  const startInput = document.querySelector("#date-start");
  const endInput = document.querySelector("#date-end");
  if (startInput) {
    startInput.value = value.startInput || value.customStart || normalizeDateInputForControl(value.start) || "";
  }
  if (endInput) {
    endInput.value = value.endInput || value.customEnd || normalizeDateInputForControl(value.end) || "";
  }
}

function setDateFilterMode(value) {
  const mode = value === "today" || value === "custom" ? value : DEFAULT_DATE_FILTER_MODE;
  const input = document.querySelector(`input[name="date-filter-mode"][value="${mode}"]`);
  if (input) {
    input.checked = true;
  }
}

function setUnknownDateMode(value) {
  const mode = value === "include" ? "include" : DEFAULT_UNKNOWN_DATE_MODE;
  const input = document.querySelector(`input[name="unknown-date-mode"][value="${mode}"]`);
  if (input) {
    input.checked = true;
  }
}

function setSpeedMode(value) {
  const mode = normalizeSpeedMode(value);
  const input = document.querySelector(`input[name="speed-mode"][value="${mode}"]`);
  if (input) {
    input.checked = true;
  }
}

function normalizeSpeedMode(value) {
  const mode = String(value || DEFAULT_SPEED_MODE).toLowerCase();
  return Object.prototype.hasOwnProperty.call(SPEED_PRESETS, mode)
    ? mode
    : DEFAULT_SPEED_MODE;
}

function speedPresetFor(value) {
  return SPEED_PRESETS[normalizeSpeedMode(value)] || SPEED_PRESETS[DEFAULT_SPEED_MODE];
}

function syncSpeedPresetControls() {
  const preset = speedPresetFor(selectedSpeedMode());
  const delayInput = document.querySelector("#delay-ms");
  const concurrencyInput = document.querySelector("#download-concurrency");
  if (delayInput) {
    delayInput.value = preset.delayMs;
  }
  if (concurrencyInput) {
    concurrencyInput.value = preset.concurrency;
  }
}

function syncDateFilterControls() {
  const isCustom = selectedDateFilterMode() === "custom";
  const range = document.querySelector("#custom-date-range");
  const startInput = document.querySelector("#date-start");
  const endInput = document.querySelector("#date-end");
  if (range) {
    range.hidden = !isCustom;
  }
  if (startInput) {
    startInput.disabled = !isCustom;
  }
  if (endInput) {
    endInput.disabled = !isCustom;
  }
}

function validateSettings(settings) {
  const filter = settings?.dateFilter || {};
  if (filter.mode !== "custom") {
    return;
  }

  const start = parseDateInputValue(filter.start);
  const end = parseDateInputValue(filter.end);
  if (start !== null && end !== null && start > end) {
    throw new Error("自定义结束时间不能早于开始时间。");
  }
}

function parseDateInputValue(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const date = new Date(text);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function dateTimeLocalValue(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }

  const date = new Date(timestamp);
  return [
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  ].join("T");
}

function normalizeDateInputForControl(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    return text.slice(0, 16);
  }

  return dateTimeLocalValue(value);
}

function numberInputValue(selector, fallback) {
  const raw = document.querySelector(selector).value;
  if (raw === "") {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

async function refreshJobStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_IMAGE_JOB_STATUS" });
    if (response?.ok) {
      renderJobStatus(response.result);
    }
  } catch {
    // The popup can still start a new task even if the first status read fails.
  }
}

async function refreshJobReport() {
  try {
    latestJobReport = await readLatestJobReport();
  } catch {
    latestJobReport = null;
  }
  syncReportActionButtons();
}

async function readLatestJobReport() {
  const result = await chrome.storage.local.get(["jobReport", "jobManifest", "imageJobReport"]);
  return result.jobReport || result.imageJobReport || result.jobManifest || null;
}

function syncReportActionButtons() {
  const hasReport = Boolean(latestJobReport && typeof latestJobReport === "object");
  exportCsvButton.disabled = !hasReport;
  retryFailedButton.disabled = latestJobIsBusy || !hasRetryableFailures(latestJobReport);
}

function hasRetryableFailures(report) {
  if (!report || typeof report !== "object") {
    return false;
  }

  return arrayField(report, "parseFailures").length > 0
    || arrayField(report, "downloadFailures").length > 0;
}

function buildCsvFilename(report = {}) {
  const jobId = String(report?.jobId || "job").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  const stamp = report?.startedAt
    ? new Date(Number(report.startedAt)).toISOString().replace(/[:.]/g, "-")
    : new Date().toISOString().replace(/[:.]/g, "-");
  return `chatgpt-images-${jobId || "job"}-${stamp}.csv`;
}

function collectJobReportCsvRows(report) {
  if (!report || typeof report !== "object") {
    return [];
  }

  const rows = [];
  const jobId = String(report.jobId || "");

  appendCsvRows(rows, jobId, "scan", arrayField(report, "scanList"), {
    status: (item) => item.status || "scanned",
    stage: "scan",
    reason: (item) => item.reason || "",
    sourceUrl: (item) => item.sourceUrl || item.resolvedUrl || item.thumbnailUrl || ""
  });
  appendCsvRows(rows, jobId, "submitted", arrayField(report, "submittedItems"), {
    status: "submitted",
    stage: (item) => item.stage || "download",
    reason: (item) => item.reason || "",
    filename: (item) => item.filename || "",
    sourceUrl: (item) => item.sourceUrl || item.url || ""
  });
  appendCsvRows(rows, jobId, "history-duplicate", arrayField(report, "skippedDuplicates"), {
    status: "skipped-duplicate",
    stage: (item) => item.stage || "history-dedupe",
    reason: (item) => item.reason || "skippedDuplicate",
    filename: (item) => item.previousFilename || item.filename || "",
    sourceUrl: (item) => item.sourceUrl || item.url || ""
  });
  appendCsvRows(rows, jobId, "scan-skipped", arrayField(report, "skippedItems"), {
    status: "skipped",
    stage: (item) => item.stage || "skip",
    reason: (item) => item.reason || "",
    sourceUrl: extractReportItemSourceUrl
  });
  appendCsvRows(rows, jobId, "time-filter-skipped", arrayField(report, "timeRangeSkippedItems"), {
    status: "skipped-time-range",
    stage: (item) => item.stage || "date-filter",
    reason: (item) => item.reason || "outside-date-range",
    sourceUrl: extractReportItemSourceUrl
  });
  appendCsvRows(rows, jobId, "unknown-date-skipped", arrayField(report, "unknownDateSkippedItems"), {
    status: "skipped-unknown-date",
    stage: (item) => item.stage || "date-filter",
    reason: (item) => item.reason || "unknown-date-skipped",
    sourceUrl: extractReportItemSourceUrl
  });
  appendCsvRows(rows, jobId, "unknown-date-included", arrayField(report, "unknownDateIncludedItems"), {
    status: "unknown-date-included",
    stage: (item) => item.stage || "date-filter",
    reason: (item) => item.reason || "unknown-date-included",
    sourceUrl: extractReportItemSourceUrl
  });
  appendCsvRows(rows, jobId, "parse-failure", arrayField(report, "parseFailures"), {
    status: "failed",
    stage: (item) => item.stage || "resolve",
    reason: (item) => item.reason || "parse-failed",
    sourceUrl: extractReportItemSourceUrl
  });
  appendCsvRows(rows, jobId, "quality-failure", arrayField(report, "qualityFailures"), {
    status: "failed",
    stage: (item) => item.stage || "quality-check",
    reason: (item) => item.reason || item.quality?.rejectReason || "quality-failed",
    sourceUrl: extractReportItemSourceUrl
  });
  appendCsvRows(rows, jobId, "download-failure", arrayField(report, "downloadFailures"), {
    status: "failed",
    stage: (item) => item.stage || "download",
    reason: (item) => item.reason || "download-failed",
    sourceUrl: extractReportItemSourceUrl
  });

  return rows;
}

function appendCsvRows(rows, jobId, rowType, items, mapping = {}) {
  for (const item of items) {
    const dateInfo = dateInfoForCsv(item);
    rows.push({
      jobId,
      rowType,
      scanIndex: item.scanIndex || item.index || "",
      imageKey: item.imageKey || "",
      date: dateInfo.date,
      dateSource: dateInfo.dateSource,
      dateCandidatesSummary: dateCandidatesSummaryForCsv(item),
      prompt: item.prompt || item.alt || "",
      sourceUrl: valueFromMapping(mapping.sourceUrl, item, ""),
      filename: valueFromMapping(mapping.filename, item, ""),
      status: valueFromMapping(mapping.status, item, ""),
      stage: valueFromMapping(mapping.stage, item, ""),
      reason: valueFromMapping(mapping.reason, item, "")
    });
  }
}

function valueFromMapping(mapping, item, fallback) {
  if (typeof mapping === "function") {
    return mapping(item);
  }
  if (mapping !== undefined) {
    return mapping;
  }
  return fallback;
}

function dateInfoForCsv(item = {}) {
  if (item.date) {
    return {
      date: item.date,
      dateSource: item.dateSource || item.diagnostic?.dateSource || ""
    };
  }

  const fallback = dateCandidatesForCsv(item).find((candidate) => {
    const source = String(candidate.source || "").toLowerCase();
    const field = String(candidate.field || "").toLowerCase();
    return candidate.normalizedDate
      && (
        source === RESPONSE_LAST_MODIFIED_DATE_SOURCE
        || (source === "response-header" && field === "last-modified")
      );
  });

  return {
    date: fallback?.normalizedDate || "",
    dateSource: fallback ? RESPONSE_LAST_MODIFIED_DATE_SOURCE : (item.dateSource || item.diagnostic?.dateSource || "")
  };
}

function extractReportItemSourceUrl(item = {}) {
  return item.sourceUrl
    || item.url
    || item.resolvedUrl
    || item.thumbnailUrl
    || item.diagnostic?.sourceUrl
    || item.diagnostic?.targetUrl
    || item.diagnostic?.url
    || item.diagnostic?.originalUrl
    || "";
}

function dateCandidatesSummaryForCsv(item = {}) {
  if (item.dateCandidatesSummary) {
    return item.dateCandidatesSummary;
  }

  const candidates = dateCandidatesForCsv(item);

  return candidates.slice(0, 12).map((candidate) => {
    const source = [candidate.source, candidate.field].filter(Boolean).join(":") || "date";
    const date = candidate.normalizedDate || "?";
    return `${source}=${date} <= ${String(candidate.value || "").slice(0, 64)}`;
  }).join(" | ");
}

function dateCandidatesForCsv(item = {}) {
  return [
    ...(Array.isArray(item.dateCandidates) ? item.dateCandidates : []),
    ...(Array.isArray(item.diagnostic?.dateCandidates) ? item.diagnostic.dateCandidates : []),
    ...(Array.isArray(item.diagnostic?.responseDateCandidates) ? item.diagnostic.responseDateCandidates : []),
    ...(Array.isArray(item.diagnostic?.fetchFailure?.dateCandidates) ? item.diagnostic.fetchFailure.dateCandidates : []),
    ...(Array.isArray(item.diagnostic?.validation?.dateCandidates) ? item.diagnostic.validation.dateCandidates : []),
    ...(Array.isArray(item.diagnostic?.diagnostic?.dateCandidates) ? item.diagnostic.diagnostic.dateCandidates : []),
    ...(Array.isArray(item.diagnostic?.diagnostic?.fetchFailure?.dateCandidates) ? item.diagnostic.diagnostic.fetchFailure.dateCandidates : []),
    ...(Array.isArray(item.diagnostic?.diagnostic?.validation?.dateCandidates) ? item.diagnostic.diagnostic.validation.dateCandidates : [])
  ];
}

function formatCsv(rows) {
  return [
    CSV_COLUMNS.join(","),
    ...rows.map((row) => CSV_COLUMNS.map((column) => csvEscape(row[column])).join(","))
  ].join("\n");
}

function csvEscape(value) {
  const text = csvCellText(value);
  return /[",\r\n]/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

function csvCellText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

async function downloadCsvFile(csv, filename) {
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    if (chrome.downloads?.download) {
      await chrome.downloads.download({
        url,
        filename,
        saveAs: true
      });
      return;
    }

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

function arrayField(source, key) {
  return Array.isArray(source?.[key]) ? source[key] : [];
}

async function refreshJobLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_IMAGE_JOB_LOGS" });
    if (response?.ok) {
      renderLogs(response.result);
    }
  } catch (error) {
    addLocalLog({
      level: "error",
      source: "popup",
      stage: "logs",
      message: "读取诊断日志失败",
      detail: { reason: error?.message || String(error) }
    });
  }
}

async function recordPopupLog(level, message, detail = null, stage = "popup") {
  const entry = {
    level,
    source: "popup",
    stage,
    message,
    detail
  };

  try {
    const response = await chrome.runtime.sendMessage({
      type: "IMAGE_JOB_LOG",
      payload: entry
    });

    if (!response?.ok) {
      throw new Error(response?.error || "日志写入失败");
    }

    await refreshJobLogs();
  } catch (error) {
    addLocalLog({
      ...entry,
      detail: {
        ...(detail && typeof detail === "object" ? detail : {}),
        logWriteError: error?.message || String(error)
      }
    });
  }
}

function addLocalLog(entry) {
  renderLogs([
    ...latestLogs,
    {
      id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      time: Date.now(),
      level: entry.level || "info",
      source: entry.source || "popup",
      stage: entry.stage || "",
      message: entry.message || "",
      detail: entry.detail || null
    }
  ].slice(-120));
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refreshJobStatus, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function renderJobStatus(job = {}) {
  const active = job.status === "running" || job.status === "downloading";
  const metrics = jobMetrics(job);
  setBusy(active);

  if (!job.status || job.status === "idle") {
    setStatus("");
    return;
  }

  if (job.status === "running") {
    const detail = job.total
      ? `\n${formatMetricsLine(metrics)}\n进度 ${job.current || 0}/${job.total}。`
      : `\n${formatMetricsLine(metrics)}\n正在收集缩略图。`;
    setStatus(`${job.message || "任务运行中..."}${detail}`);
    return;
  }

  if (job.status === "downloading") {
    setStatus(`${job.message || "正在启动下载..."}\n${formatMetricsLine(metrics)}`);
    return;
  }

  if (job.status === "done") {
    setStatus(`${job.message || "任务完成。"}\n${formatMetricsLine(metrics)}`, "success");
    return;
  }

  if (job.status === "canceled") {
    setStatus(job.message || "任务已取消。", "error");
    return;
  }

  if (job.status === "error") {
    setStatus(`${job.message || "任务失败。"}\n请刷新 ChatGPT 页面后重试。`, "error");
  }
}

function jobMetrics(job = {}) {
  const report = latestJobReport && latestJobReport.jobId === (job.id || job.jobId)
    ? latestJobReport
    : null;
  const speedMode = normalizeSpeedMode(job.speedMode || job.settings?.speedMode || report?.speedMode);
  const speedPreset = speedPresetFor(speedMode);
  const startedAt = numberMetric(job.startedAt ?? job.settings?.startedAt ?? report?.startedAt);
  const endedAt = numberMetric(job.endedAt ?? report?.endedAt);
  const isActive = job.status === "running" || job.status === "downloading";
  const totalDurationMs = numberMetric(job.totalDurationMs ?? report?.totalDurationMs)
    || (startedAt ? Math.max((endedAt || (isActive ? Date.now() : 0)) - startedAt, 0) : 0);
  const downloadDurationMs = numberMetric(job.downloadDurationMs ?? report?.downloadDurationMs);
  const submittedDownloads = numberMetric(job.submittedDownloads ?? job.downloadStarted ?? report?.submittedDownloads);
  const rateDurationMs = downloadDurationMs || totalDurationMs;

  return {
    speedMode,
    speedLabel: job.speedLabel || job.settings?.speedLabel || report?.speedLabel || speedPreset.label,
    downloadConcurrency: numberMetric(job.downloadConcurrency ?? job.settings?.downloadConcurrency ?? report?.downloadConcurrency) || speedPreset.concurrency,
    delayMs: numberMetric(job.delayMs ?? job.settings?.delayMs ?? report?.delayMs ?? speedPreset.delayMs),
    totalDurationMs,
    downloadDurationMs,
    averageDownloadsPerSecond: numberMetric(report?.averageDownloadsPerSecond) || rateMetric(submittedDownloads, rateDurationMs, 1000),
    averageDownloadsPerMinute: numberMetric(report?.averageDownloadsPerMinute) || rateMetric(submittedDownloads, rateDurationMs, 60000),
    scanListItems: numberMetric(job.scanListItems ?? report?.scanListItems ?? report?.scanList),
    scannedItems: numberMetric(job.scannedItems ?? job.scanned ?? report?.scannedItems),
    filteredIn: numberMetric(job.filteredIn ?? report?.filteredIn),
    filteredOut: numberMetric(job.filteredOut ?? report?.filteredOut),
    unknownDateCount: numberMetric(job.unknownDateCount ?? report?.unknownDateCount),
    unknownDateMode: job.unknownDateMode || job.dateFilter?.unknownDateMode || job.settings?.dateFilter?.unknownDateMode || report?.dateFilter?.unknownDateMode || DEFAULT_UNKNOWN_DATE_MODE,
    resolvedCardItems: numberMetric(job.resolvedCardItems ?? report?.resolvedCardItems),
    resolvedItems: numberMetric(job.resolvedItems ?? job.matched ?? report?.resolvedItems),
    deduplicatedItems: numberMetric(job.deduplicatedItems ?? report?.deduplicatedItems),
    skippedItems: numberMetric(job.skippedItems ?? report?.skippedItems),
    directMerged: directResourceMetric(job.directResourceSummary ?? report?.directResourceSummary, "merged"),
    directAppended: directResourceMetric(job.directResourceSummary ?? report?.directResourceSummary, "appended"),
    parseFailures: numberMetric(job.parseFailureCount ?? job.detailFailureCount ?? report?.parseFailures),
    qualityFailures: numberMetric(job.qualityFailureCount ?? job.qualityFailures ?? report?.qualityFailures),
    submittedDownloads,
    skippedDuplicates: numberMetric(job.skippedDuplicateCount ?? job.skippedDuplicates ?? report?.skippedDuplicates),
    downloadFailures: numberMetric(job.downloadFailureCount ?? job.downloadFailures ?? report?.downloadFailures)
  };
}

function numberMetric(value) {
  if (Array.isArray(value)) {
    return value.length;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function directResourceMetric(summary, key) {
  if (!summary || typeof summary !== "object") {
    return 0;
  }

  return numberMetric(summary[key]);
}

function rateMetric(count, durationMs, intervalMs) {
  const duration = Number(durationMs) || 0;
  if (duration <= 0) {
    return 0;
  }

  return Math.round(((Number(count) || 0) * intervalMs / duration) * 100) / 100;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(Math.round((Number(ms) || 0) / 1000), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatRate(value, unit) {
  const number = Number(value) || 0;
  return `${number.toFixed(number >= 10 ? 1 : 2).replace(/\.?0+$/, "")}${unit}`;
}

function unknownDateModeLabel(value) {
  return value === "include" ? "包含未知时间" : "跳过未知时间";
}

function formatMetricsLine(metrics) {
  const resolvedCardItems = metrics.resolvedCardItems
    || Math.max(metrics.scannedItems - metrics.parseFailures, metrics.resolvedItems);
  const deduplicatedItems = metrics.deduplicatedItems
    || Math.max(resolvedCardItems - metrics.resolvedItems, 0);
  const failureCount = metrics.parseFailures + metrics.qualityFailures + metrics.downloadFailures;

  return [
    `耗时 ${formatDuration(metrics.totalDurationMs)}`,
    `平均 ${formatRate(metrics.averageDownloadsPerMinute, "张/分钟")}`,
    `速度 ${metrics.speedLabel}`,
    `并发 ${metrics.downloadConcurrency}`,
    `delay ${metrics.delayMs}ms`,
    `scanList ${metrics.scanListItems || metrics.scannedItems}`,
    `扫描总数 ${metrics.scanListItems || metrics.scannedItems} 张`,
    `时间过滤后保留 ${metrics.filteredIn} 张`,
    `时间过滤跳过 ${metrics.filteredOut} 张`,
    `未知时间 ${metrics.unknownDateCount} 张`,
    `未知时间处理 ${unknownDateModeLabel(metrics.unknownDateMode)}`,
    `质量失败 ${metrics.qualityFailures} 张`,
    `扫描 ${metrics.scannedItems} 张`,
    `解析成功 ${resolvedCardItems} 张`,
    `解析失败 ${metrics.parseFailures} 张`,
    `唯一原图 ${metrics.resolvedItems} 张`,
    `skipped ${metrics.skippedItems}`,
    `direct merged ${metrics.directMerged}`,
    `direct appended ${metrics.directAppended}`,
    `跳过重复 ${metrics.skippedDuplicates} 张`,
    `已去重 ${deduplicatedItems} 张`,
    `提交下载 ${metrics.submittedDownloads} 张`,
    `失败 ${failureCount} 张`,
    `下载提交失败 ${metrics.downloadFailures} 张`
  ].join("，") + "。";
}

function renderLogs(logs = []) {
  latestLogs = Array.isArray(logs) ? logs : [];
  copyLogsButton.disabled = latestLogs.length === 0;
  clearLogsButton.disabled = latestLogs.length === 0;

  if (!latestLogs.length) {
    logListEl.textContent = "暂无日志";
    return;
  }

  logListEl.textContent = latestLogs
    .slice(-120)
    .map(formatLogLine)
    .join("\n");
  logListEl.scrollTop = logListEl.scrollHeight;
}

function formatLogLine(log) {
  const time = log.time
    ? new Date(log.time).toLocaleTimeString()
    : "--:--:--";
  const level = String(log.level || "info").toUpperCase().padEnd(5, " ");
  const source = [log.source, log.stage].filter(Boolean).join("/");
  const detail = log.detail ? ` ${JSON.stringify(log.detail)}` : "";

  return `[${time}] ${level} ${source} ${log.message || ""}${detail}`;
}

function formatLogsForCopy(logs) {
  return (logs || []).map((log) => {
    const time = log.time ? new Date(log.time).toISOString() : "";
    const detail = log.detail ? `\n  detail: ${JSON.stringify(log.detail)}` : "";
    return `${time} ${String(log.level || "info").toUpperCase()} ${log.source || ""}/${log.stage || ""} ${log.message || ""}${detail}`;
  }).join("\n");
}

function formatFailureReportForCopy(report) {
  if (!report || typeof report !== "object") {
    return "";
  }

  const parseFailures = Array.isArray(report.parseFailures) ? report.parseFailures : [];
  const qualityFailures = Array.isArray(report.qualityFailures) ? report.qualityFailures : [];
  const downloadFailures = Array.isArray(report.downloadFailures) ? report.downloadFailures : [];
  const scanList = Array.isArray(report.scanList) ? report.scanList : [];
  const skippedItems = Array.isArray(report.skippedItems) ? report.skippedItems : [];
  const skippedDuplicates = Array.isArray(report.skippedDuplicates) ? report.skippedDuplicates : [];
  const timeRangeSkippedItems = Array.isArray(report.timeRangeSkippedItems) ? report.timeRangeSkippedItems : [];
  const unknownDateSkippedItems = Array.isArray(report.unknownDateSkippedItems) ? report.unknownDateSkippedItems : [];
  const unknownDateIncludedItems = Array.isArray(report.unknownDateIncludedItems) ? report.unknownDateIncludedItems : [];

  if (!parseFailures.length && !qualityFailures.length && !downloadFailures.length && !skippedItems.length && !skippedDuplicates.length && !timeRangeSkippedItems.length && !unknownDateSkippedItems.length && !unknownDateIncludedItems.length && !scanList.length) {
    return "";
  }

  return JSON.stringify({
    jobId: report.jobId || "",
    runFolder: report.runFolder || "",
    startedAt: report.startedAt || null,
    endedAt: report.endedAt || null,
    totalDurationMs: numberMetric(report.totalDurationMs),
    downloadDurationMs: numberMetric(report.downloadDurationMs),
    speedMode: report.speedMode || DEFAULT_SPEED_MODE,
    speedLabel: report.speedLabel || speedPresetFor(report.speedMode).label,
    downloadConcurrency: numberMetric(report.downloadConcurrency) || speedPresetFor(report.speedMode).concurrency,
    delayMs: numberMetric(report.delayMs),
    averageDownloadsPerSecond: numberMetric(report.averageDownloadsPerSecond),
    averageDownloadsPerMinute: numberMetric(report.averageDownloadsPerMinute),
    scannedItems: numberMetric(report.scannedItems),
    scanListTotal: scanList.length,
    resolvedCardItems: numberMetric(report.resolvedCardItems),
    resolvedItems: numberMetric(report.resolvedItems),
    deduplicatedItems: numberMetric(report.deduplicatedItems),
    deduplicatedItemSamples: Array.isArray(report.deduplicatedItemSamples) ? report.deduplicatedItemSamples : [],
    submittedDownloads: numberMetric(report.submittedDownloads),
    skippedDuplicates,
    dateFilter: report.dateFilter || null,
    filteredIn: numberMetric(report.filteredIn),
    filteredOut: numberMetric(report.filteredOut),
    unknownDateCount: numberMetric(report.unknownDateCount),
    timeRangeSkippedItems,
    unknownDateSkippedItems,
    unknownDateIncludedItems,
    directResourceSummary: report.directResourceSummary || null,
    scanList,
    skippedItems,
    parseFailures,
    qualityFailures,
    downloadFailures
  }, null, 2);
}

function flashButtonText(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  return tab;
}

function isChatGptUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com";
  } catch {
    return false;
  }
}

function setBusy(isBusy) {
  latestJobIsBusy = Boolean(isBusy);
  startButton.disabled = isBusy;
  retryFailedButton.disabled = latestJobIsBusy || !hasRetryableFailures(latestJobReport);
  startButton.textContent = isBusy ? "处理中..." : "扫描并下载";
}

function setStatus(text, variant = "") {
  statusEl.textContent = text;
  statusEl.className = variant;
}
