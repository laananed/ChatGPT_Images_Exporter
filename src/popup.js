const form = document.querySelector("#download-form");
const startButton = document.querySelector("#start");
const statusEl = document.querySelector("#status");
const logListEl = document.querySelector("#log-list");
const copyFailuresButton = document.querySelector("#copy-failures");
const copyLogsButton = document.querySelector("#copy-logs");
const clearLogsButton = document.querySelector("#clear-logs");
const POLL_INTERVAL_MS = 1000;

let pollTimer = null;
let latestLogs = [];
let latestJobReport = null;

restoreSettings();
refreshJobStatus();
refreshJobReport();
refreshJobLogs();
startPolling();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  setStatus("准备启动后台任务...");

  try {
    const settings = readSettings();
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
        maxScrolls: settings.maxScrolls,
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
  document.querySelector("#delay-ms").value = settings.delayMs ?? 400;
  setDownloadMode(settings.downloadMode || "new");
}

function readSettings() {
  return {
    folder: document.querySelector("#folder").value.trim() || "ChatGPT Images",
    accountLabel: document.querySelector("#account-label").value.trim(),
    downloadMode: selectedDownloadMode(),
    maxScrolls: numberInputValue("#max-scrolls", 30),
    delayMs: numberInputValue("#delay-ms", 0)
  };
}

function selectedDownloadMode() {
  return document.querySelector('input[name="download-mode"]:checked')?.value === "all" ? "all" : "new";
}

function setDownloadMode(value) {
  const mode = value === "all" ? "all" : "new";
  const input = document.querySelector(`input[name="download-mode"][value="${mode}"]`);
  if (input) {
    input.checked = true;
  }
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
}

async function readLatestJobReport() {
  const result = await chrome.storage.local.get(["jobReport", "jobManifest", "imageJobReport"]);
  return result.jobReport || result.imageJobReport || result.jobManifest || null;
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

  return {
    scanListItems: numberMetric(job.scanListItems ?? report?.scanListItems ?? report?.scanList),
    scannedItems: numberMetric(job.scannedItems ?? job.scanned ?? report?.scannedItems),
    resolvedCardItems: numberMetric(job.resolvedCardItems ?? report?.resolvedCardItems),
    resolvedItems: numberMetric(job.resolvedItems ?? job.matched ?? report?.resolvedItems),
    deduplicatedItems: numberMetric(job.deduplicatedItems ?? report?.deduplicatedItems),
    skippedItems: numberMetric(job.skippedItems ?? report?.skippedItems),
    directMerged: directResourceMetric(job.directResourceSummary ?? report?.directResourceSummary, "merged"),
    directAppended: directResourceMetric(job.directResourceSummary ?? report?.directResourceSummary, "appended"),
    parseFailures: numberMetric(job.parseFailureCount ?? job.detailFailureCount ?? report?.parseFailures),
    qualityFailures: numberMetric(job.qualityFailureCount ?? job.qualityFailures ?? report?.qualityFailures),
    submittedDownloads: numberMetric(job.submittedDownloads ?? job.downloadStarted ?? report?.submittedDownloads),
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

function formatMetricsLine(metrics) {
  const resolvedCardItems = metrics.resolvedCardItems
    || Math.max(metrics.scannedItems - metrics.parseFailures, metrics.resolvedItems);
  const deduplicatedItems = metrics.deduplicatedItems
    || Math.max(resolvedCardItems - metrics.resolvedItems, 0);

  return [
    `scanList ${metrics.scanListItems || metrics.scannedItems}`,
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

  if (!parseFailures.length && !qualityFailures.length && !downloadFailures.length && !skippedItems.length && !skippedDuplicates.length && !scanList.length) {
    return "";
  }

  return JSON.stringify({
    jobId: report.jobId || "",
    runFolder: report.runFolder || "",
    startedAt: report.startedAt || null,
    endedAt: report.endedAt || null,
    scannedItems: numberMetric(report.scannedItems),
    scanListTotal: scanList.length,
    resolvedCardItems: numberMetric(report.resolvedCardItems),
    resolvedItems: numberMetric(report.resolvedItems),
    deduplicatedItems: numberMetric(report.deduplicatedItems),
    deduplicatedItemSamples: Array.isArray(report.deduplicatedItemSamples) ? report.deduplicatedItemSamples : [],
    submittedDownloads: numberMetric(report.submittedDownloads),
    skippedDuplicates,
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
  startButton.disabled = isBusy;
  startButton.textContent = isBusy ? "处理中..." : "扫描并下载";
}

function setStatus(text, variant = "") {
  statusEl.textContent = text;
  statusEl.className = variant;
}
