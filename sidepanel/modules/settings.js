import {
  imagesDirInput, transcriptDirInput, batchSizeInput,
  newChatEveryInput, focusTabToggle,
} from './dom.js';

export async function restoreSavedSettings() {
  const data = await chrome.storage.local.get(['imagesDir', 'transcriptDir', 'batchSize', 'newChatEvery', 'focusTab']);
  if (data.imagesDir) imagesDirInput.value = data.imagesDir;
  if (data.transcriptDir) transcriptDirInput.value = data.transcriptDir;
  if (data.batchSize) batchSizeInput.value = data.batchSize;
  if (data.newChatEvery !== undefined) newChatEveryInput.value = data.newChatEvery;
  if (typeof data.focusTab === 'boolean') focusTabToggle.checked = data.focusTab;
}

export async function saveSettings() {
  await chrome.storage.local.set({
    imagesDir: imagesDirInput.value.trim(),
    transcriptDir: transcriptDirInput.value.trim(),
    batchSize: batchSizeInput.value,
    newChatEvery: newChatEveryInput.value,
    focusTab: focusTabToggle.checked,
  });
}
