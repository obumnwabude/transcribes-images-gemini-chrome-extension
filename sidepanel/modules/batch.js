import { BRIDGE_URL, BATCH_MAX_ATTEMPTS, BATCH_BASE_BACKOFF_MS, BATCH_MAX_BACKOFF_MS, INTER_BATCH_DELAY_MS, DELIMITER, PROMPT_TEMPLATE } from './constants.js';
import { state } from './state.js';
import { delay, computeBackoff, getBasename, formatBytes, truncateForPreview } from './utils.js';
import { checkBridgeHealth } from './bridge.js';
import { saveSettings } from './settings.js';
import { renderQueue, updateMetrics, updateQueueItemStatus } from './queue.js';
import { logTerminal, appendPreviewText, renderActiveBatch, setPipelineStep, resetPipelineSteps, renderPauseButton, progressStatusLabel } from './ui.js';
import {
  imagesDirInput, transcriptDirInput, batchSizeInput, newChatEveryInput, focusTabToggle,
  btnStartBatch, btnPauseBatch, btnStopBatch, btnSkipBatch, btnScanFolder,
  activeFileCard,
} from './dom.js';

// --- Folder scan ---

export async function scanImagesFolder() {
  await saveSettings();
  const imagesDir = imagesDirInput.value.trim();
  const transcriptDir = transcriptDirInput.value.trim();

  if (!imagesDir) {
    alert('Please enter the Images folder path.');
    return;
  }

  const isHealthy = await checkBridgeHealth();
  if (!isHealthy) {
    alert("Local bridge is offline. Run 'python3 server.py' in your terminal first.");
    return;
  }

  btnScanFolder.disabled = true;
  btnScanFolder.textContent = 'Scanning...';

  try {
    const res = await fetch(`${BRIDGE_URL}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagesDir, transcriptDir }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.activeImagesDir = data.imagesDir || imagesDir;
    state.activeTranscriptDir = data.transcriptDir || transcriptDir;

    state.queue = data.files.map((f, idx) => ({
      ...f,
      id: idx,
      status: f.alreadyDone ? 'skipped' : 'pending',
    }));

    renderQueue();
    updateMetrics();
    progressStatusLabel.textContent = `Scanned ${state.queue.length} image${state.queue.length === 1 ? '' : 's'}.`;
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

// --- Gemini tab helpers ---

export async function ensureContentScriptReady(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (res && res.status === 'PONG') return true;
  } catch (e) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/gemini-automator.js'],
    });
    await delay(600);
    const check = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return Boolean(check && check.status === 'PONG');
  } catch (err) {
    console.warn('[Transcriber] Auto-inject content script:', err);
    return false;
  }
}

export async function startNewChat(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'START_NEW_CHAT' });
    if (res && res.success) {
      await delay(1500);
      return true;
    }
  } catch (e) {}

  try {
    await chrome.tabs.update(tabId, { url: 'https://gemini.google.com/app' });
    await waitForTabComplete(tabId);
    await ensureContentScriptReady(tabId);
    await delay(2000);
    return true;
  } catch (err) {
    console.warn('[Transcriber] Failed to start new chat via tab update:', err);
    return false;
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
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

export async function focusGeminiWindowIfEnabled() {
  if (!focusTabToggle.checked) return;
  if (state.activeGeminiTabId == null || state.activeGeminiWindowId == null) return;
  try {
    await chrome.windows.update(state.activeGeminiWindowId, { focused: true, state: 'normal' });
    await chrome.tabs.update(state.activeGeminiTabId, { active: true });
  } catch (e) {
    console.warn('[Transcriber] Focus Gemini window failed:', e);
  }
}

// --- Sleep ---

export async function sleepInterruptible(ms) {
  const step = 250;
  let elapsed = 0;
  while (elapsed < ms) {
    if (!state.isRunning || state.shouldSkipCurrentBatch) return;
    await delay(Math.min(step, ms - elapsed));
    elapsed += step;
  }
}

// --- Transcript save ---

export async function saveTranscript(transcriptDir, filename, content) {
  const res = await fetch(`${BRIDGE_URL}/save-transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcriptDir, filename, content }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Failed to save ${filename}: ${data.error}`);
}

// --- Response parsing ---

export function splitAndValidateResponse(response, delimiter, expectedCount) {
  if (!response) throw new Error('Empty response from Gemini.');
  const rawParts = response.split(delimiter).map((p) => p.trim()).filter((p) => p.length > 0);
  if (rawParts.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} transcript parts, got ${rawParts.length}.`);
  }
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

// --- Batch status helpers ---

export function markBatchProcessing(batch) {
  for (const item of batch) {
    if (item.status !== 'done') {
      item.status = 'processing';
      updateQueueItemStatus(item.id, 'status-processing', 'Processing');
    }
  }
  updateMetrics();
}

export function unmarkBatchProcessing(batch) {
  for (const item of batch) {
    if (item.status === 'processing') {
      item.status = 'pending';
      updateQueueItemStatus(item.id, 'status-pending', 'Pending');
    }
  }
  updateMetrics();
}

// --- Core batch runners ---

export async function tryRunBatchOnce(batch, geminiTabId, transcriptDir) {
  const filenames = batch.map((f) => f.filename);
  logTerminal(`\n[batch] ${batch.length} image(s): ${filenames.join(', ')}`);

  let lastErr = null;

  for (let attempt = 1; attempt <= BATCH_MAX_ATTEMPTS; attempt++) {
    if (!state.isRunning || state.shouldSkipCurrentBatch) return false;

    try {
      if (attempt > 1) {
        const wait = computeBackoff(attempt - 1, BATCH_BASE_BACKOFF_MS, BATCH_MAX_BACKOFF_MS);
        logTerminal(`[retry] Batch attempt ${attempt}/${BATCH_MAX_ATTEMPTS} after ${Math.round(wait / 1000)}s`);
        await sleepInterruptible(wait);
        if (!state.isRunning || state.shouldSkipCurrentBatch) return false;
      }

      await focusGeminiWindowIfEnabled();

      const connected = await ensureContentScriptReady(geminiTabId);
      if (!connected) {
        throw new Error('Could not connect to Gemini tab. Ensure gemini.google.com is open and refresh it.');
      }

      setPipelineStep('attach');

      const images = batch.map((f) => ({
        filename: f.filename,
        fileUrl: `${BRIDGE_URL}/get-file?path=${encodeURIComponent(f.filepath)}&root=${encodeURIComponent(state.activeImagesDir)}`,
      }));

      const promptText = PROMPT_TEMPLATE(batch.length, DELIMITER);

      setPipelineStep('gemini');
      const response = await chrome.tabs.sendMessage(geminiTabId, {
        type: 'TRANSCRIBE_BATCH',
        images,
        promptText,
        delimiter: DELIMITER,
        attempt,
      });

      if (!response || !response.success) {
        const err = new Error(response?.error || 'Content script failed to transcribe batch');
        if (response && response.refusal) err.isRefusal = true;
        if (response && response.aborted) err.isAbort = true;
        throw err;
      }

      setPipelineStep('split');
      const parts = splitAndValidateResponse(response.response, DELIMITER, batch.length);

      const totalLen = parts.reduce((n, p) => n + p.length, 0);
      if (totalLen < 4 * batch.length) {
        throw new Error(`Combined transcript length ${totalLen} is implausibly short for ${batch.length} images.`);
      }

      setPipelineStep('save');
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const text = parts[i];
        const outName = `${getBasename(item.filename)}.txt`;
        await saveTranscript(transcriptDir, outName, text);
        item.status = 'done';
        updateQueueItemStatus(item.id, 'status-done', 'Completed');
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

  logTerminal(`[error] Batch failed after ${BATCH_MAX_ATTEMPTS} attempts${lastErr ? `: ${lastErr.message}` : ''}`);
  return false;
}

export async function processBatchWithBisect(batch, geminiTabId, transcriptDir) {
  if (batch.length === 0) return;

  markBatchProcessing(batch);
  renderActiveBatch(batch);

  const ok = await tryRunBatchOnce(batch, geminiTabId, transcriptDir);
  if (ok) return;

  if (state.shouldSkipCurrentBatch || !state.isRunning || state.hardStopRequested) {
    unmarkBatchProcessing(batch);
    return;
  }

  if (batch.length === 1) {
    const item = batch[0];
    item.status = 'failed';
    updateQueueItemStatus(item.id, 'status-pending', 'Failed');
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
  if (!state.isRunning || state.shouldSkipCurrentBatch) return;
  await processBatchWithBisect(right, geminiTabId, transcriptDir);
}

// --- Manual controls ---

export async function handleManualNewChat() {
  try {
    let tabId = state.activeGeminiTabId;
    if (tabId == null) {
      const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      if (!tabs || tabs.length === 0) {
        alert('No gemini.google.com tab found.');
        return;
      }
      tabId = tabs[0].id;
    }
    const ok = await ensureContentScriptReady(tabId);
    if (!ok) {
      alert('Could not connect to the Gemini tab. Refresh it and try again.');
      return;
    }
    logTerminal('[chat] Starting fresh chat (manual).');
    await startNewChat(tabId);
    logTerminal('[chat] Fresh chat opened.');
  } catch (err) {
    logTerminal(`[warn] New chat failed: ${err.message}`);
  }
}

export async function hardStopBatch() {
  if (!state.isRunning) return;
  state.hardStopRequested = true;
  state.isRunning = false;
  state.isPaused = false;
  logTerminal('[stop] Hard stop requested by user.');
  if (state.activeGeminiTabId != null) {
    try { await chrome.tabs.sendMessage(state.activeGeminiTabId, { type: 'ABORT' }); } catch (e) {}
  }
}

export function togglePause() {
  state.isPaused = !state.isPaused;
  renderPauseButton();
  if (state.isPaused && state.activeGeminiTabId != null) {
    chrome.tabs.sendMessage(state.activeGeminiTabId, { type: 'ABORT' }).catch(() => {});
    logTerminal('[pause] Paused; current batch aborted.');
  }
}

// --- Batch orchestrator ---

export async function startBatchProcessing() {
  if (state.isRunning) return;

  const pendingItems = state.queue.filter((f) => f.status === 'pending');
  if (pendingItems.length === 0) {
    alert('No pending images to transcribe.');
    return;
  }

  const transcriptDir = transcriptDirInput.value.trim();
  if (!transcriptDir) {
    alert('Please specify the Transcripts Output Folder path.');
    return;
  }
  state.activeTranscriptDir = transcriptDir;

  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (!tabs || tabs.length === 0) {
    const shouldOpen = confirm('No active gemini.google.com tab found. Open one now?');
    if (shouldOpen) await chrome.tabs.create({ url: 'https://gemini.google.com' });
    return;
  }

  const geminiTab = tabs[0];
  state.activeGeminiTabId = geminiTab.id;
  state.activeGeminiWindowId = geminiTab.windowId;

  progressStatusLabel.textContent = 'Connecting to Gemini tab...';
  const isScriptReady = await ensureContentScriptReady(geminiTab.id);
  if (!isScriptReady) {
    alert('Could not connect to your gemini.google.com tab.\nRefresh gemini.google.com (Cmd+R) and click Start again.');
    progressStatusLabel.textContent = 'Please refresh Gemini tab.';
    return;
  }

  try {
    state.prevAutoDiscardable = geminiTab.autoDiscardable !== false;
    await chrome.tabs.update(geminiTab.id, { autoDiscardable: false });
  } catch (e) {
    console.warn('[Transcriber] autoDiscardable=false failed:', e);
  }

  try { await chrome.tabs.sendMessage(geminiTab.id, { type: 'START_KEEPALIVE' }); } catch (e) {}

  state.isRunning = true;
  state.isPaused = false;
  state.hardStopRequested = false;
  btnStartBatch.classList.add('hidden');
  btnPauseBatch.classList.remove('hidden');
  btnStopBatch.classList.remove('hidden');
  btnSkipBatch.disabled = false;
  activeFileCard.classList.remove('hidden');

  const batchSize = Math.max(1, parseInt(batchSizeInput.value, 10) || 10);
  const newChatEvery = Math.max(0, parseInt(newChatEveryInput.value, 10) || 0);
  let batchesSinceNewChat = 0;

  try {
    while (state.isRunning) {
      while (state.isPaused) {
        progressStatusLabel.textContent = 'Paused...';
        await delay(1000);
        if (!state.isRunning) break;
      }
      if (!state.isRunning) break;

      const batch = state.queue.filter((f) => f.status === 'pending').slice(0, batchSize);
      if (batch.length === 0) break;

      state.shouldSkipCurrentBatch = false;
      await processBatchWithBisect(batch, geminiTab.id, state.activeTranscriptDir);
      batchesSinceNewChat += 1;

      if (newChatEvery > 0 && batchesSinceNewChat >= newChatEvery && state.isRunning && !state.hardStopRequested) {
        const stillPending = state.queue.some((f) => f.status === 'pending');
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

      if (state.isRunning && !state.shouldSkipCurrentBatch) {
        await sleepInterruptible(INTER_BATCH_DELAY_MS);
      }
    }
  } finally {
    state.isRunning = false;
    btnStartBatch.classList.remove('hidden');
    btnPauseBatch.classList.add('hidden');
    btnStopBatch.classList.add('hidden');
    btnSkipBatch.disabled = true;
    activeFileCard.classList.add('hidden');
    resetPipelineSteps();
    progressStatusLabel.textContent = state.hardStopRequested
      ? 'Stopped by user.'
      : 'Batch processing finished.';

    if (state.activeGeminiTabId != null) {
      try { await chrome.tabs.sendMessage(state.activeGeminiTabId, { type: 'STOP_KEEPALIVE' }); } catch (e) {}
      try { await chrome.tabs.update(state.activeGeminiTabId, { autoDiscardable: state.prevAutoDiscardable !== false }); } catch (e) {}
    }
    state.activeGeminiTabId = null;
    state.activeGeminiWindowId = null;
    state.prevAutoDiscardable = null;
  }
}
