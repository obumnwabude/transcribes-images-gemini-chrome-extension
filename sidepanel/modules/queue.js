import { state } from './state.js';
import { formatBytes } from './utils.js';
import {
  metricTotal, metricDone, metricSkipped, metricRemaining,
  progressBar, progressPercentage,
  queueCountBadge, queueContainer,
} from './dom.js';

export function renderQueue() {
  queueCountBadge.textContent = `${state.queue.length} images`;
  if (state.queue.length === 0) {
    queueContainer.innerHTML = `
      <div class="empty-state">
        <p>No image files found in specified folder.</p>
      </div>`;
    return;
  }

  queueContainer.innerHTML = state.queue.map((f) => {
    let statusClass = 'status-pending';
    let statusText = 'Pending';

    if (f.status === 'skipped') {
      statusClass = 'status-skipped';
      statusText = 'Done (Skipped)';
    } else if (f.status === 'done') {
      statusClass = 'status-done';
      statusText = 'Completed';
    } else if (f.status === 'processing') {
      statusClass = 'status-processing';
      statusText = 'Transcribing';
    } else if (f.status === 'failed') {
      statusClass = 'status-pending';
      statusText = 'Failed';
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
  }).join('');
}

export function updateMetrics() {
  const total = state.queue.length;
  const done = state.queue.filter((f) => f.status === 'done').length;
  const skipped = state.queue.filter((f) => f.status === 'skipped').length;
  const remaining = state.queue.filter((f) => f.status === 'pending' || f.status === 'processing').length;

  metricTotal.textContent = total;
  metricDone.textContent = done;
  metricSkipped.textContent = skipped;
  metricRemaining.textContent = remaining;

  const processed = done + skipped;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressPercentage.textContent = `${pct}%`;
}

export function updateQueueItemStatus(id, className, text) {
  const el = document.getElementById(`queue-status-${id}`);
  if (el) {
    el.className = `status-pill ${className}`;
    el.textContent = text;
  }
}
