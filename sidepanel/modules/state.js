export const state = {
  queue: [],
  isRunning: false,
  isPaused: false,
  shouldSkipCurrentBatch: false,
  hardStopRequested: false,
  activeImagesDir: '',
  activeTranscriptDir: '',
  activeGeminiTabId: null,
  activeGeminiWindowId: null,
  prevAutoDiscardable: null,
};
