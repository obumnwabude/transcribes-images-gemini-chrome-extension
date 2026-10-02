import { state } from './state.js';
import { formatBytes, truncateForPreview } from './utils.js';
import {
  transcriptPreview, btnPauseBatch,
  stepAttach, stepGemini, stepSplit, stepSave,
  activeBatchLabel, activeBatchMeta, activeBatchList,
  progressStatusLabel,
} from './dom.js';

export { progressStatusLabel };

export function logTerminal(msg) {
  console.log(msg);
  const placeholder = transcriptPreview.querySelector('.terminal-placeholder');
  if (placeholder) placeholder.remove();
  const line = document.createElement('div');
  line.textContent = msg;
  transcriptPreview.appendChild(line);
  transcriptPreview.scrollTop = transcriptPreview.scrollHeight;
}

export function appendPreviewText(text) {
  const block = document.createElement('div');
  block.style.color = '#a5b4fc';
  block.style.whiteSpace = 'pre-wrap';
  block.textContent = text;
  transcriptPreview.appendChild(block);
  transcriptPreview.scrollTop = transcriptPreview.scrollHeight;
}

export function renderActiveBatch(batch) {
  activeBatchLabel.textContent = `Batch of ${batch.length}`;
  const totalBytes = batch.reduce((n, f) => n + (f.size || 0), 0);
  activeBatchMeta.textContent = `${batch.length} image${batch.length === 1 ? '' : 's'} | ${formatBytes(totalBytes)}`;
  activeBatchList.innerHTML = batch.map((f) => `<span class="batch-chip" title="${f.filename}">${f.filename}</span>`).join('');
  progressStatusLabel.textContent = `Transcribing batch of ${batch.length}...`;
}

export function setPipelineStep(step) {
  const order = ['attach', 'gemini', 'split', 'save'];
  const idx = order.indexOf(step);
  const els = { attach: stepAttach, gemini: stepGemini, split: stepSplit, save: stepSave };
  order.forEach((name, i) => {
    const el = els[name];
    if (!el) return;
    if (i < idx) el.className = 'step-item done';
    else if (i === idx) el.className = 'step-item active';
    else el.className = 'step-item';
  });
}

export function resetPipelineSteps() {
  stepAttach.className = 'step-item';
  stepGemini.className = 'step-item';
  stepSplit.className = 'step-item';
  stepSave.className = 'step-item';
}

export function renderPauseButton() {
  if (state.isPaused) {
    btnPauseBatch.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg> Resume`;
    btnPauseBatch.className = 'btn btn-primary btn-large';
  } else {
    btnPauseBatch.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="6" y="4" width="4" height="16"/>
        <rect x="14" y="4" width="4" height="16"/>
      </svg> Pause`;
    btnPauseBatch.className = 'btn btn-warning btn-large';
  }
}
