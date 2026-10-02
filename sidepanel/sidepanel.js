import {
  checkBridgeHealth,
  handleManualNewChat,
  hardStopBatch,
  restoreSavedSettings,
  saveSettings,
  scanImagesFolder,
  startBatchProcessing,
  togglePause,
  logTerminal,
} from './modules/index.js';
import { state } from './modules/state.js';
import {
  btnRefreshHealth, btnScanFolder,
  imagesDirInput, transcriptDirInput, batchSizeInput, newChatEveryInput, focusTabToggle,
  btnStartBatch, btnPauseBatch, btnStopBatch, btnSkipBatch, btnNewChat,
  btnClearPreview, transcriptPreview,
} from './modules/dom.js';

document.addEventListener('DOMContentLoaded', async () => {
  await restoreSavedSettings();
  await checkBridgeHealth();
  setupEventListeners();
});

function setupEventListeners() {
  btnRefreshHealth.addEventListener('click', checkBridgeHealth);
  btnScanFolder.addEventListener('click', scanImagesFolder);

  imagesDirInput.addEventListener('change', saveSettings);
  transcriptDirInput.addEventListener('change', saveSettings);
  batchSizeInput.addEventListener('change', saveSettings);
  newChatEveryInput.addEventListener('change', saveSettings);
  focusTabToggle.addEventListener('change', saveSettings);

  btnClearPreview.addEventListener('click', () => {
    transcriptPreview.innerHTML = '<span class="terminal-placeholder">Live output cleared.</span>';
  });

  btnStartBatch.addEventListener('click', startBatchProcessing);
  btnPauseBatch.addEventListener('click', togglePause);
  btnStopBatch.addEventListener('click', hardStopBatch);

  btnSkipBatch.addEventListener('click', () => {
    state.shouldSkipCurrentBatch = true;
    if (state.activeGeminiTabId != null) {
      chrome.tabs.sendMessage(state.activeGeminiTabId, { type: 'ABORT' }).catch(() => {});
    }
    logTerminal('[skip] Skipping current batch on user request.');
  });

  btnNewChat.addEventListener('click', handleManualNewChat);
}
