/**
 * Gemini Automator Content Script (image batch mode)
 * Automates multi-image attachment, verbatim OCR prompt submission, and response scraping on gemini.google.com
 */

console.log("[Gemini Automator] Content script loaded and active.");

const RESPONSE_TIMEOUT_MS = 8 * 60 * 1000;
const RESPONSE_STABILITY_MS = 1800;
const SEND_ENABLE_WAIT_MS = 240000;
const HUMAN_POST_ATTACH_MIN_MS = 3500;
const HUMAN_POST_ATTACH_MAX_MS = 6500;
const HUMAN_POST_PROMPT_MIN_MS = 1500;
const HUMAN_POST_PROMPT_MAX_MS = 3500;

let abortRequested = false;

function humanJitter(minMs, maxMs) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

let keepaliveAudio = null;
let keepaliveAudioUrl = null;
let keepaliveWatchdog = null;
let keepaliveVisibilityHandler = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "PING") {
    sendResponse({ status: "PONG" });
    return true;
  }

  if (request.type === "START_KEEPALIVE") {
    startSilentAudioKeepalive();
    sendResponse({ success: true, playing: Boolean(keepaliveAudio && !keepaliveAudio.paused) });
    return true;
  }

  if (request.type === "STOP_KEEPALIVE") {
    stopSilentAudioKeepalive();
    sendResponse({ success: true });
    return true;
  }

  if (request.type === "ABORT") {
    abortRequested = true;
    console.log("[Gemini Automator] ABORT received; halting current work.");
    sendResponse({ success: true });
    return true;
  }

  if (request.type === "START_NEW_CHAT") {
    abortRequested = false;
    handleStartNewChat()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.type === "TRANSCRIBE_BATCH") {
    abortRequested = false;
    handleTranscribeBatch(request)
      .then((response) => sendResponse({ success: true, response }))
      .catch((err) => sendResponse({
        success: false,
        error: err.message,
        refusal: Boolean(err.isRefusal),
        aborted: Boolean(err.isAbort),
      }));
    return true;
  }
});

function checkAborted() {
  if (abortRequested) {
    const err = new Error("Aborted by user.");
    err.isAbort = true;
    throw err;
  }
}

async function abortAwareDelay(ms) {
  const step = 200;
  let elapsed = 0;
  while (elapsed < ms) {
    checkAborted();
    await delay(Math.min(step, ms - elapsed));
    elapsed += step;
  }
}

function makeSilentWavBlobUrl(seconds = 3, sampleRate = 8000) {
  const numSamples = Math.floor(seconds * sampleRate);
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

function startSilentAudioKeepalive() {
  try {
    if (keepaliveAudio) return;

    keepaliveAudioUrl = makeSilentWavBlobUrl(3, 8000);
    const audio = new Audio(keepaliveAudioUrl);
    audio.loop = true;
    audio.volume = 0.0;
    audio.muted = false;
    audio.preload = "auto";
    audio.setAttribute("aria-hidden", "true");
    keepaliveAudio = audio;

    const tryPlay = () => {
      if (!keepaliveAudio) return;
      const p = keepaliveAudio.play();
      if (p && typeof p.catch === "function") {
        p.catch((err) => {
          const resume = () => {
            document.removeEventListener("click", resume, true);
            document.removeEventListener("keydown", resume, true);
            tryPlay();
          };
          document.addEventListener("click", resume, true);
          document.addEventListener("keydown", resume, true);
          console.warn("[Gemini Automator] Keepalive audio blocked, awaiting a click in the Gemini page:", err && err.message);
        });
      }
    };
    tryPlay();

    keepaliveWatchdog = setInterval(() => {
      if (!keepaliveAudio) return;
      if (keepaliveAudio.paused || keepaliveAudio.ended || keepaliveAudio.readyState < 2) {
        tryPlay();
      }
    }, 4000);

    keepaliveVisibilityHandler = () => {
      if (keepaliveAudio && keepaliveAudio.paused) tryPlay();
    };
    document.addEventListener("visibilitychange", keepaliveVisibilityHandler);
    window.addEventListener("focus", keepaliveVisibilityHandler);
    window.addEventListener("blur", keepaliveVisibilityHandler);

    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: "Transcriber keepalive", artist: " " });
        navigator.mediaSession.setActionHandler("play", () => tryPlay());
        navigator.mediaSession.setActionHandler("pause", () => { /* refuse to pause */ });
      }
    } catch (e) {}

    console.log("[Gemini Automator] Silent audio keepalive armed.");
  } catch (e) {
    console.warn("[Gemini Automator] Keepalive audio failed:", e);
  }
}

function stopSilentAudioKeepalive() {
  try {
    if (keepaliveWatchdog) {
      clearInterval(keepaliveWatchdog);
      keepaliveWatchdog = null;
    }
    if (keepaliveVisibilityHandler) {
      document.removeEventListener("visibilitychange", keepaliveVisibilityHandler);
      window.removeEventListener("focus", keepaliveVisibilityHandler);
      window.removeEventListener("blur", keepaliveVisibilityHandler);
      keepaliveVisibilityHandler = null;
    }
    if (keepaliveAudio) {
      try { keepaliveAudio.pause(); } catch (e) {}
      try { keepaliveAudio.src = ""; } catch (e) {}
      keepaliveAudio = null;
    }
    if (keepaliveAudioUrl) {
      try { URL.revokeObjectURL(keepaliveAudioUrl); } catch (e) {}
      keepaliveAudioUrl = null;
    }
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = null;
      }
    } catch (e) {}
  } catch (e) {}
}

async function handleStartNewChat() {
  console.log("[Gemini Automator] Starting fresh new chat...");

  const newChatBtn = document.querySelector(
    'button[aria-label*="New chat"], a[aria-label*="New chat"], [data-test-id="new-chat-button"], button.new-chat-button, a[href="/app"], a[data-test-id="new-chat"]'
  );

  if (newChatBtn) {
    newChatBtn.click();
    console.log("[Gemini Automator] Clicked 'New chat' button.");
    await delay(1800);
    return true;
  }

  const existingBubbles = document.querySelectorAll(
    '.model-response-text, .message-content, message-content, [data-test-id="conversation-turn"]'
  );
  if (window.location.pathname.endsWith("/app") && existingBubbles.length === 0) {
    console.log("[Gemini Automator] Already on a clean new chat.");
    return true;
  }

  window.location.href = "https://gemini.google.com/app";
  await delay(2500);
  return true;
}

async function handleTranscribeBatch(request) {
  const { images, promptText, delimiter } = request;

  if (!Array.isArray(images) || images.length === 0) {
    throw new Error("No images provided in batch");
  }
  if (!promptText || !delimiter) {
    throw new Error("promptText and delimiter are required");
  }

  console.log(`[Gemini Automator] Preparing batch of ${images.length} image(s)...`);

  const files = [];
  for (const img of images) {
    if (!img.fileUrl) throw new Error(`Missing fileUrl for ${img.filename}`);
    const res = await fetch(img.fileUrl);
    if (!res.ok) throw new Error(`Bridge returned ${res.status} fetching ${img.filename}`);
    const blob = await res.blob();
    files.push(new File([blob], img.filename, { type: blob.type || "image/jpeg" }));
  }

  await removeExistingAttachments();
  await ensureImagesAttached(files);

  // Human-like settle after attach before typing.
  const postAttachWait = humanJitter(HUMAN_POST_ATTACH_MIN_MS, HUMAN_POST_ATTACH_MAX_MS);
  console.log(`[Gemini Automator] Post-attach human delay ${postAttachWait}ms.`);
  await abortAwareDelay(postAttachWait);

  await enterPrompt(promptText);

  // Human-like settle after typing prompt, before send.
  const postPromptWait = humanJitter(HUMAN_POST_PROMPT_MIN_MS, HUMAN_POST_PROMPT_MAX_MS);
  console.log(`[Gemini Automator] Post-prompt human delay ${postPromptWait}ms.`);
  await abortAwareDelay(postPromptWait);

  const initialBubbleCount = document.querySelectorAll(
    '.model-response-text, .message-content, message-content, [data-test-id="conversation-turn"] .response'
  ).length;

  await clickSendButton();

  const responseText = await waitForGeminiResponse(initialBubbleCount);

  if (isMissingImagesOrRefusal(responseText)) {
    const err = new Error("Gemini reported that images were not attached.");
    err.isRefusal = true;
    throw err;
  }

  return responseText;
}

// --- Attachment ---
async function removeExistingAttachments() {
  const removeBtns = document.querySelectorAll(
    'button[aria-label*="remove" i][aria-label*="attachment" i], button[aria-label*="Remove file" i], button[aria-label*="Delete file" i]'
  );
  for (const btn of removeBtns) {
    try { btn.click(); } catch (e) {}
  }
  if (removeBtns.length > 0) {
    await delay(500);
  }
}

function findFileInputDeep(root = document) {
  let input = root.querySelector('input[type="file"]');
  if (input) return input;
  const all = root.querySelectorAll("*");
  for (const el of all) {
    if (el.shadowRoot) {
      input = findFileInputDeep(el.shadowRoot);
      if (input) return input;
    }
  }
  return null;
}

function composerRoot() {
  return (
    document.querySelector('input-area-v2') ||
    document.querySelector('.input-area-container') ||
    document.querySelector('[class*="input-area" i]') ||
    document.querySelector('[class*="composer" i]') ||
    document.querySelector('rich-textarea')?.parentElement ||
    null
  );
}

async function locateFileInput() {
  // Prefer file inputs inside the composer subtree, so we don't accidentally
  // grab any file input that Gemini might render elsewhere on the page (for
  // example inside a previous-message viewer).
  const composer = composerRoot();
  if (composer) {
    const scoped = findFileInputDeep(composer);
    if (scoped) return scoped;
  }
  const global = findFileInputDeep();
  if (global) return global;

  // Only click Add buttons that live inside the composer. Buttons like
  // "View file", "Open attachment" or "Attached file" appear on previous
  // conversation messages and would pop up image viewers if we clicked them.
  if (composer) {
    const addBtns = composer.querySelectorAll(
      'button[aria-label*="Add" i], button[aria-label*="Upload" i], button[aria-label*="attach" i], button.input-area-add-button, button[data-test-id*="upload" i]'
    );
    for (const btn of addBtns) {
      try { btn.click(); } catch (e) {}
      await delay(400);
      const input = findFileInputDeep(composerRoot() || document);
      if (input) return input;
    }
  }
  return null;
}

async function ensureImagesAttached(files) {
  const expectedCount = files.length;
  console.log(`[Gemini Automator] Attaching ${expectedCount} file(s)...`);

  const fileInput = await locateFileInput();
  if (!fileInput) {
    throw new Error("Could not find Gemini's file input on the page.");
  }

  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  fileInput.dispatchEvent(new Event("input", { bubbles: true }));

  const taken = fileInput.files ? fileInput.files.length : 0;
  console.log(`[Gemini Automator] Input took ${taken}/${expectedCount} file(s).`);
  if (taken === 0) {
    throw new Error(`File input rejected all ${expectedCount} file(s).`);
  }

  // Small settle so the composer reacts to the new files before we type.
  await delay(800);
  return true;
}

function isMissingImagesOrRefusal(text) {
  if (!text) return false;
  // A long response is almost certainly a real transcription, even if it
  // happens to contain refusal-shaped substrings inside verbatim content.
  if (text.length > 800) return false;
  const lower = text.toLowerCase().trim();

  const refusalPhrases = [
    "please attach the image",
    "please attach an image",
    "please attach the images",
    "please provide the image",
    "please provide an image",
    "please provide the images",
    "please upload the image",
    "please upload an image",
    "please upload the images",
    "please share the image",
    "please send the image",
    "you haven't attached",
    "you didn't attach",
    "you haven't provided",
    "you didn't provide",
    "haven't attached an image",
    "didn't attach an image",
    "haven't attached any image",
    "didn't attach any image",
    "there is no image",
    "there's no image",
    "no image file",
    "no images were attached",
    "no image was attached",
    "no image attached",
    "no images attached",
    "no image was provided",
    "i don't see any image",
    "i don't see an image",
    "i cannot see any image",
    "i cannot find any image",
    "i can't find any image",
    "i can't see any image",
    "it looks like you forgot to attach",
    "it looks like you didn't attach",
    "you forgot to attach",
    "attachment is missing",
    "image is missing",
    "images are missing",
    "as an ai, i need an image",
    "to transcribe, please attach",
    "to transcribe, please provide",
    "need an image to transcribe",
    "i'd be happy to transcribe, but",
    "i would be happy to transcribe, but",
    "if you can provide the image",
    "if you can attach the image",
    "once you attach the image",
    "once you upload the image",
    "could you please attach the image",
    "could you attach the image",
    "could you provide the image",
    "image file wasn't attached",
    "where is the image",
    "make sure to attach the image",
    "make sure to upload the image",
    "cannot transcribe without",
  ];

  for (const phrase of refusalPhrases) {
    if (lower.includes(phrase)) return true;
  }

  if (lower.length < 400) {
    const hasImageWord =
      lower.includes("image") || lower.includes("picture") || lower.includes("photo") ||
      lower.includes("file") || lower.includes("attachment");
    const hasActionWord =
      lower.includes("attach") || lower.includes("upload") || lower.includes("provide") ||
      lower.includes("missing") || lower.includes("forgot") || lower.includes("share");

    if (hasImageWord && hasActionWord) {
      if (
        lower.startsWith("i ") ||
        lower.startsWith("please ") ||
        lower.startsWith("it ") ||
        lower.startsWith("sure") ||
        lower.startsWith("certainly") ||
        lower.startsWith("hello") ||
        lower.startsWith("hi") ||
        lower.startsWith("to ") ||
        lower.includes("transcribe")
      ) {
        return true;
      }
    }
  }

  return false;
}

async function enterPrompt(text) {
  const promptBox = document.querySelector('rich-textarea p, div[contenteditable="true"][role="textbox"], textarea');
  if (!promptBox) {
    throw new Error("Could not find Gemini's prompt input box.");
  }

  promptBox.focus();

  if (promptBox.tagName === "TEXTAREA") {
    promptBox.value = text;
  } else {
    promptBox.textContent = text;
  }

  promptBox.dispatchEvent(new Event("input", { bubbles: true }));
  promptBox.dispatchEvent(new Event("change", { bubbles: true }));
  promptBox.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

  await delay(600);
}

function findSendButton() {
  return document.querySelector(
    'button[aria-label*="Send prompt" i], button[aria-label*="Send message" i], button[jsname="V67aGc"], button.send-button'
  );
}

function isSendDisabled(btn) {
  if (!btn) return true;
  return btn.getAttribute("aria-disabled") === "true" || btn.disabled;
}

async function clickSendButton() {
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < SEND_ENABLE_WAIT_MS) {
    checkAborted();
    const btn = findSendButton();
    if (btn && !isSendDisabled(btn)) {
      btn.click();
      console.log("[Gemini Automator] Clicked Send.");
      await delay(2000);
      return;
    }
    if (Date.now() - lastLog > 5000) {
      console.log(`[Gemini Automator] Waiting for Send to enable... (${Math.round((Date.now() - start) / 1000)}s)`);
      lastLog = Date.now();
    }
    await delay(500);
  }
  throw new Error(`Send button remained disabled for ${SEND_ENABLE_WAIT_MS / 1000}s. Uploads may not have completed.`);
}

function waitForGeminiResponse(initialCount = 0) {
  return new Promise((resolve, reject) => {
    console.log(`[Gemini Automator] Watching for response (initial bubbles: ${initialCount})...`);
    let stabilityTimer = null;
    let lastLength = 0;
    let hasSeenGenerationStart = false;

    const maxTimeout = setTimeout(() => {
      cleanup();
      reject(new Error("Gemini response timed out after 8 minutes."));
    }, RESPONSE_TIMEOUT_MS);

    const abortPoller = setInterval(() => {
      if (abortRequested) {
        cleanup();
        const err = new Error("Aborted by user.");
        err.isAbort = true;
        reject(err);
      }
    }, 400);

    const checkCompletion = () => {
      const stopBtn = document.querySelector(
        'button[aria-label*="Stop response"], button[aria-label*="Stop"]'
      );
      if (stopBtn) hasSeenGenerationStart = true;

      const responseBubbles = document.querySelectorAll(
        '.model-response-text, .message-content, message-content, [data-test-id="conversation-turn"] .response'
      );

      if (responseBubbles.length <= initialCount && !hasSeenGenerationStart) return;

      const latestBubble = responseBubbles[responseBubbles.length - 1];
      if (!latestBubble) return;

      const text = latestBubble.innerText.trim();

      if (!stopBtn && text.length > 0) {
        if (text.length === lastLength) {
          if (!stabilityTimer) {
            stabilityTimer = setTimeout(() => {
              cleanup();
              resolve(cleanResponseText(text));
            }, RESPONSE_STABILITY_MS);
          }
        } else {
          lastLength = text.length;
          if (stabilityTimer) {
            clearTimeout(stabilityTimer);
            stabilityTimer = null;
          }
        }
      }
    };

    const observer = new MutationObserver(checkCompletion);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const interval = setInterval(checkCompletion, 1500);

    function cleanup() {
      clearTimeout(maxTimeout);
      clearInterval(abortPoller);
      if (stabilityTimer) clearTimeout(stabilityTimer);
      clearInterval(interval);
      observer.disconnect();
    }
  });
}

function cleanResponseText(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```") && cleaned.endsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  return cleaned;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
