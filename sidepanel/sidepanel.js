/**
 * Gemini Batch Image Transcriber - Side Panel Controller
 */

const BRIDGE_URL = "http://127.0.0.1:8765";

const BATCH_MAX_ATTEMPTS = 2;
const BATCH_BASE_BACKOFF_MS = 8000;
const BATCH_MAX_BACKOFF_MS = 120000;
const INTER_BATCH_DELAY_MS = 12000;

const DELIMITER = "[[IMAGE_BREAK]]";

const PROMPT_TEMPLATE = (n, delimiter) =>
`I've attached ${n} image${n === 1 ? "" : "s"}. Transcribe each image VERBATIM into GitHub-Flavored Markdown.

Verbatim rules (non-negotiable):
- Copy the visible text EXACTLY as it appears. Do NOT summarise, paraphrase, rephrase, translate, correct spelling or grammar, reorder, or invent any content.
- Include every visible character: numbering, punctuation, dashes, parentheses, question marks, page/question numbers, option letters (A, B, C, D), etc.

Formatting rules (Markdown for structure only, never for embellishment):
- Tables: use GFM pipe tables (with a header separator row).
- Headings: use #, ##, ### where the image shows visually distinct headings.
- Lists: use - for bulleted lists and 1. 2. 3. for numbered lists, matching the image.
- Emphasis: use **bold** and *italic* only where visually present.
- Math: use inline $...$ or block $$...$$ when the image shows mathematical notation. Do NOT convert plain numbers into math.
- Code / monospace blocks: use fenced \`\`\` code blocks only when the image shows code or monospace text.
- Do NOT wrap the ENTIRE response in a single code fence.
- Do NOT add commentary, introductions, explanations, image descriptions, filenames, or your own image/page numbering.

Output structure (STRICT):
- Before EACH image's transcription, output one line containing exactly the token [[N=k]] where k is the 1-based image position: [[N=1]] for the first image, [[N=2]] for the second, and so on up to [[N=${n}]]. This ordinal marker line is NOT part of the transcription; it is only a label for what follows.
- Type [[N=k]] literally. Do NOT wrap it in markdown, code fences, quotes, HTML, or escapes.
${n === 1 ? "- Do NOT output any delimiter between images (there is only one image)." :
`- Between consecutive image blocks, output the LITERAL delimiter token below on its own line, and nothing else on that line. Type it exactly, no markdown wrapping:

${delimiter}

- Your response must contain exactly ${n - 1} occurrence${(n - 1) === 1 ? "" : "s"} of that delimiter.
- Output the ${n} blocks in the same order the images were attached. Do NOT output the delimiter before [[N=1]] or after the last block.`}

Begin your response with the line [[N=1]] followed immediately on the next line by the first character of image 1.`;

// State
let queue = [];
let isRunning = false;
let isPaused = false;
let shouldSkipCurrentBatch = false;
let hardStopRequested = false;
let activeImagesDir = "";
let activeTranscriptDir = "";
let activeGeminiTabId = null;
let activeGeminiWindowId = null;
let prevAutoDiscardable = null;

// DOM
const bridgeBadge = document.getElementById("bridgeBadge");
const bridgeStatusText = document.getElementById("bridgeStatusText");
const btnRefreshHealth = document.getElementById("btnRefreshHealth");

const imagesDirInput = document.getElementById("imagesDirInput");
const transcriptDirInput = document.getElementById("transcriptDirInput");
const batchSizeInput = document.getElementById("batchSizeInput");
const newChatEveryInput = document.getElementById("newChatEveryInput");
const btnScanFolder = document.getElementById("btnScanFolder");

const metricTotal = document.getElementById("metricTotal");
const metricDone = document.getElementById("metricDone");
const metricSkipped = document.getElementById("metricSkipped");
const metricRemaining = document.getElementById("metricRemaining");

const progressStatusLabel = document.getElementById("progressStatusLabel");
const progressPercentage = document.getElementById("progressPercentage");
const progressBar = document.getElementById("progressBar");

const activeFileCard = document.getElementById("activeFileCard");
const activeBatchLabel = document.getElementById("activeBatchLabel");
const activeBatchMeta = document.getElementById("activeBatchMeta");
const activeBatchList = document.getElementById("activeBatchList");

const stepAttach = document.getElementById("stepAttach");
const stepGemini = document.getElementById("stepGemini");
const stepSplit = document.getElementById("stepSplit");
const stepSave = document.getElementById("stepSave");

const transcriptPreview = document.getElementById("transcriptPreview");
const btnClearPreview = document.getElementById("btnClearPreview");

const btnStartBatch = document.getElementById("btnStartBatch");
const btnPauseBatch = document.getElementById("btnPauseBatch");
const btnStopBatch = document.getElementById("btnStopBatch");
const btnSkipBatch = document.getElementById("btnSkipBatch");
const btnNewChat = document.getElementById("btnNewChat");

const queueCountBadge = document.getElementById("queueCountBadge");
const queueContainer = document.getElementById("queueContainer");
const focusTabToggle = document.getElementById("focusTabToggle");

document.addEventListener("DOMContentLoaded", async () => {
  await restoreSavedSettings();
  await checkBridgeHealth();
  setupEventListeners();
});

function setupEventListeners() {
  btnRefreshHealth.addEventListener("click", checkBridgeHealth);
  btnScanFolder.addEventListener("click", scanImagesFolder);

  imagesDirInput.addEventListener("change", saveSettings);
  transcriptDirInput.addEventListener("change", saveSettings);
  batchSizeInput.addEventListener("change", saveSettings);
  newChatEveryInput.addEventListener("change", saveSettings);
  focusTabToggle.addEventListener("change", saveSettings);

  btnClearPreview.addEventListener("click", () => {
    transcriptPreview.innerHTML = '<span class="terminal-placeholder">Live output cleared.</span>';
  });

  btnStartBatch.addEventListener("click", startBatchProcessing);
  btnPauseBatch.addEventListener("click", togglePause);
  btnStopBatch.addEventListener("click", hardStopBatch);
  btnSkipBatch.addEventListener("click", () => {
    shouldSkipCurrentBatch = true;
    if (activeGeminiTabId != null) {
      chrome.tabs.sendMessage(activeGeminiTabId, { type: "ABORT" }).catch(() => {});
    }
    logTerminal("[skip] Skipping current batch on user request.");
  });
  btnNewChat.addEventListener("click", handleManualNewChat);
}

async function handleManualNewChat() {
  try {
    let tabId = activeGeminiTabId;
    if (tabId == null) {
      const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
      if (!tabs || tabs.length === 0) {
        alert("No gemini.google.com tab found.");
        return;
      }
      tabId = tabs[0].id;
    }
    const ok = await ensureContentScriptReady(tabId);
    if (!ok) {
      alert("Could not connect to the Gemini tab. Refresh it and try again.");
      return;
    }
    logTerminal("[chat] Starting fresh chat (manual).");
    await startNewChat(tabId);
    logTerminal("[chat] Fresh chat opened.");
  } catch (err) {
    logTerminal(`[warn] New chat failed: ${err.message}`);
  }
}

async function hardStopBatch() {
  if (!isRunning) return;
  hardStopRequested = true;
  isRunning = false;
  isPaused = false;
  logTerminal("[stop] Hard stop requested by user.");
  if (activeGeminiTabId != null) {
    try { await chrome.tabs.sendMessage(activeGeminiTabId, { type: "ABORT" }); } catch (e) {}
  }
}

// --- Storage ---
async function restoreSavedSettings() {
  const data = await chrome.storage.local.get(["imagesDir", "transcriptDir", "batchSize", "newChatEvery", "focusTab"]);
  if (data.imagesDir) imagesDirInput.value = data.imagesDir;
  if (data.transcriptDir) transcriptDirInput.value = data.transcriptDir;
  if (data.batchSize) batchSizeInput.value = data.batchSize;
  if (data.newChatEvery !== undefined) newChatEveryInput.value = data.newChatEvery;
  if (typeof data.focusTab === "boolean") focusTabToggle.checked = data.focusTab;
}

async function saveSettings() {
  await chrome.storage.local.set({
    imagesDir: imagesDirInput.value.trim(),
    transcriptDir: transcriptDirInput.value.trim(),
    batchSize: batchSizeInput.value,
    newChatEvery: newChatEveryInput.value,
    focusTab: focusTabToggle.checked,
  });
}

// --- Bridge Health ---
async function checkBridgeHealth() {
  bridgeStatusText.textContent = "Connecting...";
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data.status === "ok") {
      bridgeBadge.className = "badge badge-online";
      bridgeStatusText.textContent = "Bridge Online";
      return true;
    }
    bridgeBadge.className = "badge badge-offline";
    bridgeStatusText.textContent = "Bridge Error";
    return false;
  } catch (err) {
    bridgeBadge.className = "badge badge-offline";
    bridgeStatusText.textContent = "Bridge Offline";
    return false;
  }
}

// --- Folder Scan ---
async function scanImagesFolder() {
  await saveSettings();
  const imagesDir = imagesDirInput.value.trim();
  const transcriptDir = transcriptDirInput.value.trim();

  if (!imagesDir) {
    alert("Please enter the Images folder path.");
    return;
  }

  const isHealthy = await checkBridgeHealth();
  if (!isHealthy) {
    alert("Local bridge is offline. Run 'python3 server.py' in your terminal first.");
    return;
  }

  btnScanFolder.disabled = true;
  btnScanFolder.textContent = "Scanning...";

  try {
    const res = await fetch(`${BRIDGE_URL}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imagesDir, transcriptDir }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    activeImagesDir = data.imagesDir || imagesDir;
    activeTranscriptDir = data.transcriptDir || transcriptDir;

    queue = data.files.map((f, idx) => ({
      ...f,
      id: idx,
      status: f.alreadyDone ? "skipped" : "pending",
    }));

    renderQueue();
    updateMetrics();
    progressStatusLabel.textContent = `Scanned ${queue.length} image${queue.length === 1 ? "" : "s"}.`;
  } catch (err) {
    alert(`Scan error: ${err.message}`);
  } finally {
    btnScanFolder.disabled = false;
    btnScanFolder.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg> Scan Folder`;
  }
}

function renderQueue() {
  queueCountBadge.textContent = `${queue.length} images`;
  if (queue.length === 0) {
    queueContainer.innerHTML = `
      <div class="empty-state">
        <p>No image files found in specified folder.</p>
      </div>`;
    return;
  }

  queueContainer.innerHTML = queue.map((f) => {
    let statusClass = "status-pending";
    let statusText = "Pending";

    if (f.status === "skipped") {
      statusClass = "status-skipped";
      statusText = "Done (Skipped)";
    } else if (f.status === "done") {
      statusClass = "status-done";
      statusText = "Completed";
    } else if (f.status === "processing") {
      statusClass = "status-processing";
      statusText = "Transcribing";
    } else if (f.status === "failed") {
      statusClass = "status-pending";
      statusText = "Failed";
    }

    const sizeFormatted = formatBytes(f.size);

    return `
      <div class="queue-item" id="queue-item-${f.id}">
        <div class="queue-item-info">
          <span class="queue-item-name" title="${f.filename}">${f.filename}</span>
          <span class="queue-item-sub">${sizeFormatted}</span>
        </div>
        <span class="status-pill ${statusClass}" id="queue-status-${f.id}">${statusText}</span>
      </div>`;
  }).join("");
}

function updateMetrics() {
  const total = queue.length;
  const done = queue.filter((f) => f.status === "done").length;
  const skipped = queue.filter((f) => f.status === "skipped").length;
  const remaining = queue.filter((f) => f.status === "pending" || f.status === "processing").length;

  metricTotal.textContent = total;
  metricDone.textContent = done;
  metricSkipped.textContent = skipped;
  metricRemaining.textContent = remaining;

  const processed = done + skipped;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressPercentage.textContent = `${pct}%`;
}

// --- Batch orchestration ---
async function startBatchProcessing() {
  if (isRunning) return;

  const pendingItems = queue.filter((f) => f.status === "pending");
  if (pendingItems.length === 0) {
    alert("No pending images to transcribe.");
    return;
  }

  const transcriptDir = transcriptDirInput.value.trim();
  if (!transcriptDir) {
    alert("Please specify the Transcripts Output Folder path.");
    return;
  }
  activeTranscriptDir = transcriptDir;

  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  if (!tabs || tabs.length === 0) {
    const shouldOpen = confirm("No active gemini.google.com tab found. Open one now?");
    if (shouldOpen) {
      await chrome.tabs.create({ url: "https://gemini.google.com" });
    }
    return;
  }

  const geminiTab = tabs[0];
  activeGeminiTabId = geminiTab.id;
  activeGeminiWindowId = geminiTab.windowId;

  progressStatusLabel.textContent = "Connecting to Gemini tab...";
  const isScriptReady = await ensureContentScriptReady(geminiTab.id);
  if (!isScriptReady) {
    alert("Could not connect to your gemini.google.com tab.\nRefresh gemini.google.com (Cmd+R) and click Start again.");
    progressStatusLabel.textContent = "Please refresh Gemini tab.";
    return;
  }

  try {
    prevAutoDiscardable = geminiTab.autoDiscardable !== false;
    await chrome.tabs.update(geminiTab.id, { autoDiscardable: false });
  } catch (e) {
    console.warn("[Transcriber] autoDiscardable=false failed:", e);
  }

  try {
    await chrome.tabs.sendMessage(geminiTab.id, { type: "START_KEEPALIVE" });
  } catch (e) {}

  isRunning = true;
  isPaused = false;
  hardStopRequested = false;
  btnStartBatch.classList.add("hidden");
  btnPauseBatch.classList.remove("hidden");
  btnStopBatch.classList.remove("hidden");
  btnSkipBatch.disabled = false;
  activeFileCard.classList.remove("hidden");

  const batchSize = Math.max(1, parseInt(batchSizeInput.value, 10) || 10);
  const newChatEvery = Math.max(0, parseInt(newChatEveryInput.value, 10) || 0);
  let batchesSinceNewChat = 0;

  try {
    while (isRunning) {
      while (isPaused) {
        progressStatusLabel.textContent = "Paused...";
        await delay(1000);
        if (!isRunning) break;
      }
      if (!isRunning) break;

      const batch = queue.filter((f) => f.status === "pending").slice(0, batchSize);
      if (batch.length === 0) break;

      shouldSkipCurrentBatch = false;
      await processBatchWithBisect(batch, geminiTab.id, activeTranscriptDir);
      batchesSinceNewChat += 1;

      if (
        newChatEvery > 0 &&
        batchesSinceNewChat >= newChatEvery &&
        isRunning &&
        !hardStopRequested
      ) {
        const stillPending = queue.some((f) => f.status === "pending");
        if (stillPending) {
          logTerminal(`[chat] ${batchesSinceNewChat} batch(es) done; opening a fresh chat.`);
          try {
            await startNewChat(geminiTab.id);
            batchesSinceNewChat = 0;
          } catch (err) {
            logTerminal(`[warn] Auto new-chat failed: ${err.message}`);
          }
        }
      }

      if (isRunning && !shouldSkipCurrentBatch) {
        await sleepInterruptible(INTER_BATCH_DELAY_MS);
      }
    }
  } finally {
    isRunning = false;
    btnStartBatch.classList.remove("hidden");
    btnPauseBatch.classList.add("hidden");
    btnStopBatch.classList.add("hidden");
    btnSkipBatch.disabled = true;
    activeFileCard.classList.add("hidden");
    resetPipelineSteps();
    progressStatusLabel.textContent = hardStopRequested
      ? "Stopped by user."
      : "Batch processing finished.";

    if (activeGeminiTabId != null) {
      try {
        await chrome.tabs.sendMessage(activeGeminiTabId, { type: "STOP_KEEPALIVE" });
      } catch (e) {}
      try {
        await chrome.tabs.update(activeGeminiTabId, { autoDiscardable: prevAutoDiscardable !== false });
      } catch (e) {}
    }
    activeGeminiTabId = null;
    activeGeminiWindowId = null;
    prevAutoDiscardable = null;
  }
}

async function focusGeminiWindowIfEnabled() {
  if (!focusTabToggle.checked) return;
  if (activeGeminiTabId == null || activeGeminiWindowId == null) return;
  try {
    await chrome.windows.update(activeGeminiWindowId, { focused: true, state: "normal" });
    await chrome.tabs.update(activeGeminiTabId, { active: true });
  } catch (e) {
    console.warn("[Transcriber] Focus Gemini window failed:", e);
  }
}

/**
 * Try to process a batch. If the response can't be split into the expected
 * number of parts (or the batch is refused), bisect and retry each half.
 * A batch of size 1 that still fails is marked as failed.
 */
async function processBatchWithBisect(batch, geminiTabId, transcriptDir) {
  if (batch.length === 0) return;

  markBatchProcessing(batch);
  renderActiveBatch(batch);

  const ok = await tryRunBatchOnce(batch, geminiTabId, transcriptDir);
  if (ok) return;

  if (shouldSkipCurrentBatch || !isRunning || hardStopRequested) {
    unmarkBatchProcessing(batch);
    return;
  }

  if (batch.length === 1) {
    const item = batch[0];
    item.status = "failed";
    updateQueueItemStatus(item.id, "status-pending", "Failed");
    updateMetrics();
    logTerminal(`[error] ${item.filename} failed after all attempts.`);
    return;
  }

  const half = Math.max(1, Math.floor(batch.length / 2));
  const left = batch.slice(0, half);
  const right = batch.slice(half);
  logTerminal(`[bisect] Splitting batch of ${batch.length} into ${left.length} + ${right.length} and retrying.`);
  unmarkBatchProcessing(batch);
  await processBatchWithBisect(left, geminiTabId, transcriptDir);
  if (!isRunning || shouldSkipCurrentBatch) return;
  await processBatchWithBisect(right, geminiTabId, transcriptDir);
}

async function tryRunBatchOnce(batch, geminiTabId, transcriptDir) {
  const filenames = batch.map((f) => f.filename);
  logTerminal(`\n[batch] ${batch.length} image(s): ${filenames.join(", ")}`);

  let lastErr = null;

  for (let attempt = 1; attempt <= BATCH_MAX_ATTEMPTS; attempt++) {
    if (!isRunning || shouldSkipCurrentBatch) return false;

    try {
      if (attempt > 1) {
        const wait = computeBackoff(attempt - 1, BATCH_BASE_BACKOFF_MS, BATCH_MAX_BACKOFF_MS);
        logTerminal(`[retry] Batch attempt ${attempt}/${BATCH_MAX_ATTEMPTS} after ${Math.round(wait / 1000)}s`);
        await sleepInterruptible(wait);
        if (!isRunning || shouldSkipCurrentBatch) return false;
      }

      await focusGeminiWindowIfEnabled();

      const connected = await ensureContentScriptReady(geminiTabId);
      if (!connected) {
        throw new Error("Could not connect to Gemini tab. Ensure gemini.google.com is open and refresh it.");
      }

      // Stay in the current chat. Use the New Chat button to start a fresh
      // one manually if the context gets too large or the chat misbehaves.
      setPipelineStep("attach");

      const images = batch.map((f) => ({
        filename: f.filename,
        fileUrl: `${BRIDGE_URL}/get-file?path=${encodeURIComponent(f.filepath)}&root=${encodeURIComponent(activeImagesDir)}`,
      }));

      const promptText = PROMPT_TEMPLATE(batch.length, DELIMITER);

      setPipelineStep("gemini");
      const response = await chrome.tabs.sendMessage(geminiTabId, {
        type: "TRANSCRIBE_BATCH",
        images,
        promptText,
        delimiter: DELIMITER,
        attempt,
      });

      if (!response || !response.success) {
        const err = new Error(response?.error || "Content script failed to transcribe batch");
        if (response && response.refusal) err.isRefusal = true;
        if (response && response.aborted) err.isAbort = true;
        throw err;
      }

      setPipelineStep("split");
      const parts = splitAndValidateResponse(response.response, DELIMITER, batch.length);

      // Guard against Gemini producing an obviously refusal-shaped short response
      // that happens to have the right delimiter count (rare, but cheap to check).
      const totalLen = parts.reduce((n, p) => n + p.length, 0);
      if (totalLen < 4 * batch.length) {
        throw new Error(`Combined transcript length ${totalLen} is implausibly short for ${batch.length} images.`);
      }

      setPipelineStep("save");
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const text = parts[i];
        const outName = `${getBasename(item.filename)}.txt`;
        await saveTranscript(transcriptDir, outName, text);
        item.status = "done";
        updateQueueItemStatus(item.id, "status-done", "Completed");
        logTerminal(`[save] ${outName} (${text.length} chars)`);
        appendPreviewText(`[${item.filename}]\n${truncateForPreview(text)}\n\n`);
      }
      updateMetrics();
      return true;
    } catch (err) {
      lastErr = err;
      logTerminal(`[warn] Batch attempt ${attempt}/${BATCH_MAX_ATTEMPTS}: ${err.message}`);
      if (err.isAbort) {
        logTerminal(`[abort] Batch aborted by user; not retrying.`);
        return false;
      }
    }
  }

  logTerminal(`[error] Batch failed after ${BATCH_MAX_ATTEMPTS} attempts${lastErr ? `: ${lastErr.message}` : ""}`);
  return false;
}

function splitAndValidateResponse(response, delimiter, expectedCount) {
  if (!response) throw new Error("Empty response from Gemini.");
  const rawParts = response.split(delimiter).map((p) => p.trim()).filter((p) => p.length > 0);
  if (rawParts.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} transcript parts, got ${rawParts.length}.`);
  }
  // Accept optional markdown wrapping (e.g. bold/italic) around the marker.
  const markerRe = /^\s*[*_`]*\[\[\s*N\s*=\s*(\d+)\s*\]\][*_`]*\s*\n?/;
  const clean = [];
  for (let i = 0; i < rawParts.length; i++) {
    const m = rawParts[i].match(markerRe);
    if (!m) {
      throw new Error(`Part ${i + 1} is missing the [[N=k]] ordinal marker.`);
    }
    const n = parseInt(m[1], 10);
    if (n !== i + 1) {
      throw new Error(`Ordinal mismatch: part ${i + 1} claims to be image ${n}. Order may be wrong; refusing to save.`);
    }
    clean.push(rawParts[i].slice(m[0].length).trim());
  }
  return clean;
}

async function saveTranscript(transcriptDir, filename, content) {
  const res = await fetch(`${BRIDGE_URL}/save-transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcriptDir, filename, content }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Failed to save ${filename}: ${data.error}`);
}

function markBatchProcessing(batch) {
  for (const item of batch) {
    if (item.status !== "done") {
      item.status = "processing";
      updateQueueItemStatus(item.id, "status-processing", "Processing");
    }
  }
  updateMetrics();
}

function unmarkBatchProcessing(batch) {
  for (const item of batch) {
    if (item.status === "processing") {
      item.status = "pending";
      updateQueueItemStatus(item.id, "status-pending", "Pending");
    }
  }
  updateMetrics();
}

function renderActiveBatch(batch) {
  activeBatchLabel.textContent = `Batch of ${batch.length}`;
  const totalBytes = batch.reduce((n, f) => n + (f.size || 0), 0);
  activeBatchMeta.textContent = `${batch.length} image${batch.length === 1 ? "" : "s"} | ${formatBytes(totalBytes)}`;
  activeBatchList.innerHTML = batch.map((f) => `<span class="batch-chip" title="${f.filename}">${f.filename}</span>`).join("");
  progressStatusLabel.textContent = `Transcribing batch of ${batch.length}...`;
}

// --- Backoff & Sleep ---
function computeBackoff(step, base, cap) {
  const exp = Math.min(cap, base * Math.pow(2, step - 1));
  const jitter = Math.random() * Math.min(1000, exp * 0.2);
  return Math.round(exp + jitter);
}

async function sleepInterruptible(ms) {
  const step = 250;
  let elapsed = 0;
  while (elapsed < ms) {
    if (!isRunning || shouldSkipCurrentBatch) return;
    await delay(Math.min(step, ms - elapsed));
    elapsed += step;
  }
}

// --- Pipeline UI ---
function setPipelineStep(step) {
  const order = ["attach", "gemini", "split", "save"];
  const idx = order.indexOf(step);
  const els = { attach: stepAttach, gemini: stepGemini, split: stepSplit, save: stepSave };
  order.forEach((name, i) => {
    const el = els[name];
    if (!el) return;
    if (i < idx) el.className = "step-item done";
    else if (i === idx) el.className = "step-item active";
    else el.className = "step-item";
  });
}

function resetPipelineSteps() {
  stepAttach.className = "step-item";
  stepGemini.className = "step-item";
  stepSplit.className = "step-item";
  stepSave.className = "step-item";
}

function updateQueueItemStatus(id, className, text) {
  const el = document.getElementById(`queue-status-${id}`);
  if (el) {
    el.className = `status-pill ${className}`;
    el.textContent = text;
  }
}

function togglePause() {
  isPaused = !isPaused;
  renderPauseButton();
  if (isPaused && activeGeminiTabId != null) {
    // Ask the content script to abort any in-flight wait so the batch can
    // stop mid-generation instead of finishing and burning more tokens.
    chrome.tabs.sendMessage(activeGeminiTabId, { type: "ABORT" }).catch(() => {});
    logTerminal("[pause] Paused; current batch aborted.");
  }
}

function renderPauseButton() {
  if (isPaused) {
    btnPauseBatch.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg> Resume`;
    btnPauseBatch.className = "btn btn-primary btn-large";
  } else {
    btnPauseBatch.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="6" y="4" width="4" height="16"/>
        <rect x="14" y="4" width="4" height="16"/>
      </svg> Pause`;
    btnPauseBatch.className = "btn btn-warning btn-large";
  }
}

function logTerminal(msg) {
  console.log(msg);
  const placeholder = transcriptPreview.querySelector(".terminal-placeholder");
  if (placeholder) placeholder.remove();

  const line = document.createElement("div");
  line.textContent = msg;
  transcriptPreview.appendChild(line);
  transcriptPreview.scrollTop = transcriptPreview.scrollHeight;
}

function appendPreviewText(text) {
  const block = document.createElement("div");
  block.style.color = "#a5b4fc";
  block.style.whiteSpace = "pre-wrap";
  block.textContent = text;
  transcriptPreview.appendChild(block);
  transcriptPreview.scrollTop = transcriptPreview.scrollHeight;
}

function truncateForPreview(text, max = 400) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

async function ensureContentScriptReady(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (res && res.status === "PONG") return true;
  } catch (e) {
    // Not attached yet.
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/gemini-automator.js"],
    });
    await delay(600);
    const check = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return Boolean(check && check.status === "PONG");
  } catch (err) {
    console.warn("[Transcriber] Auto-inject content script:", err);
    return false;
  }
}

async function startNewChat(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "START_NEW_CHAT" });
    if (res && res.success) {
      await delay(1500);
      return true;
    }
  } catch (e) {
    // Message channel may close if the tab navigates.
  }

  try {
    await chrome.tabs.update(tabId, { url: "https://gemini.google.com/app" });
    await waitForTabComplete(tabId);
    await ensureContentScriptReady(tabId);
    await delay(2000);
    return true;
  } catch (err) {
    console.warn("[Transcriber] Failed to start new chat via tab update:", err);
    return false;
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

// --- Utilities ---
function getBasename(filename) {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.substring(0, idx) : filename;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
