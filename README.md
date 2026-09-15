# Gemini Batch Image Transcriber (Chrome Extension + Local Bridge)

A Chrome Extension (Manifest V3) paired with a tiny local Python file server that batch-transcribes a folder of images to plain text using `gemini.google.com`. No API key. Uses your existing Gemini session in Chrome.

---

## What it does

Point it at a folder of images. It attaches N images per Gemini message (default 10), tells Gemini to output each image's verbatim text separated by a delimiter line, splits the response, and writes one `<basename>.txt` per input image to your output folder. Already-transcribed files are skipped on rescan.

- **Verbatim only**: prompt tells Gemini not to summarise, paraphrase, translate, or reformat.
- **Batched**: 10 images per Gemini turn by default; adjustable (1, 3, 5, 10, 15, 20).
- **Delimiter-based split**: response is cut on `<<<===IMG-BREAK===>>>` lines, then each part is saved.
- **Bisect on failure**: if a batch's response has the wrong number of parts (or is a refusal), the batch is split in half and retried automatically, down to single-image runs.
- **Auto-skip done files**: an input with a non-empty `<basename>.txt` in the output folder is marked `Done (Skipped)`.
- **Fresh chat per batch**: keeps context clean and cheap.

---

## Quick Start

### 1. Start the local file bridge

```bash
python3 server.py
```

You should see:

```text
Gemini Image Transcriber Local Bridge
Listening on http://127.0.0.1:8765
Supported image types: .bmp, .gif, .jpeg, .jpg, .png, .webp
```

Leave it running.

### 2. Load the extension in Chrome

1. Open `chrome://extensions/`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and pick this project directory.
4. The extension icon appears in your toolbar.

### 3. Run the batch

1. Open [gemini.google.com](https://gemini.google.com) and make sure you're logged in.
2. Click the extension icon to open the **Side Panel**.
3. Confirm the status pill says **Bridge Online** (green).
4. Fill in:
   - **Images Folder Path** (e.g. `/Users/you/some_images_folder`)
   - **Transcripts Output Folder Path** (e.g. `/Users/you/plain_transcribed`)
   - **Images per Gemini message** (default 10)
5. Click **Scan Folder**. The queue populates.
6. Click **Start Batch Transcription**.

---

## Under the hood

```
[Images folder on disk]
           |
           v
[Local bridge: server.py]
  /scan       -> list image files, mark already-done
  /get-file   -> serve raw image bytes to the content script
  /save-transcript -> atomic write of one .txt per image
           |
           v
[Side panel orchestrator]
  Take next N pending images -> build batch
  Start fresh Gemini chat
  Send batch to content script
           |
           v
[Content script on gemini.google.com]
  Attach N images via DataTransfer -> file input
  Wait for N attachment chips
  Enter verbatim prompt with delimiter instructions
  Send, wait for streamed response to stabilise
  Return raw response text
           |
           v
[Side panel]
  Split response on delimiter, verify part count == N
  On mismatch or refusal: bisect batch and retry
  Save each part as <basename>.txt
```

---

## Notes

- Prompt lives in [sidepanel/sidepanel.js](sidepanel/sidepanel.js) as `PROMPT_TEMPLATE`. Edit there if you want to tweak wording.
- The delimiter is `<<<===IMG-BREAK===>>>`. If you change it, change it in the same file (`DELIMITER`) and the split regex handles surrounding whitespace and optional markdown emphasis wrapping.
- Filenames with characters outside `A-Za-z0-9._-  ()[]` are rejected by the bridge's save endpoint. Rename inputs if you hit this.
- HEIC and multi-page PDFs are not supported. Pre-convert if you need them.
