#!/usr/bin/env python3
"""
Local file bridge for Gemini Batch Image Transcriber Chrome Extension.
Runs on http://127.0.0.1:8765 with zero external pip dependencies.

Responsibilities:
  - Scan an input folder for image files.
  - Serve raw image bytes to the content script (fast local fetch).
  - Save each per-image verbatim transcript to <output>/<basename>.txt.
"""

import http.server
import json
import mimetypes
import os
import re
import shutil
import socketserver
import sys
import tempfile
import urllib.parse

PORT = 8765
SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9._\- ()\[\]]+$")


def safe_basename(name):
    """Reject names containing path separators or traversal segments."""
    if not name:
        return None
    if "/" in name or "\\" in name or name in ("..", "."):
        return None
    if not SAFE_NAME_RE.match(name):
        return None
    return name


class FileBridgeHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), format % args))

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def send_json(self, data, status=200):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def read_json_body(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                return {}
            raw_body = self.rfile.read(content_length).decode("utf-8")
            return json.loads(raw_body)
        except Exception as e:
            print(f"[Error] Failed to read JSON body: {e}", file=sys.stderr)
            return {}

    def _path_is_under(self, path, root):
        """True when path resolves to something inside root."""
        try:
            path_r = os.path.realpath(path)
            root_r = os.path.realpath(root)
            return path_r == root_r or path_r.startswith(root_r + os.sep)
        except Exception:
            return False

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/health":
            self.send_json({"status": "ok"})
            return

        if path == "/get-file":
            params = urllib.parse.parse_qs(parsed.query)
            file_path = params.get("path", [None])[0]
            root = params.get("root", [None])[0]

            if not file_path or not os.path.isfile(file_path):
                self.send_json({"error": "File not found"}, status=404)
                return

            # Restrict reads to the images root that scan() ran under.
            if root and not self._path_is_under(file_path, os.path.expanduser(root)):
                self.send_json({"error": "Path outside allowed root"}, status=403)
                return

            mime_type, _ = mimetypes.guess_type(file_path)
            if not mime_type:
                mime_type = "application/octet-stream"

            file_size = os.path.getsize(file_path)
            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Content-Disposition", f'inline; filename="{os.path.basename(file_path)}"')
            self.end_headers()

            with open(file_path, "rb") as f:
                shutil.copyfileobj(f, self.wfile)
            return

        self.send_json({"error": "Not Found"}, status=404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.read_json_body()

        if path == "/scan":
            self._handle_scan(body)
            return

        if path == "/save-transcript":
            self._handle_save_transcript(body)
            return

        self.send_json({"error": "Not Found"}, status=404)

    def _handle_scan(self, body):
        images_dir = os.path.expanduser(body.get("imagesDir", "").strip())
        transcript_dir = os.path.expanduser(body.get("transcriptDir", "").strip())

        if not images_dir or not os.path.isdir(images_dir):
            self.send_json({"error": f"Images directory does not exist: {images_dir}"}, status=400)
            return

        if transcript_dir and not os.path.exists(transcript_dir):
            try:
                os.makedirs(transcript_dir, exist_ok=True)
            except PermissionError:
                self.send_json({
                    "error": f"Permission Denied for '{transcript_dir}'. Grant your Terminal access to the folder in System Settings > Privacy & Security, or move the folder to a standard location."
                }, status=403)
                return
            except Exception as e:
                self.send_json({"error": f"Could not create transcript directory: {e}"}, status=400)
                return

        try:
            raw_items = sorted(os.listdir(images_dir))
        except PermissionError:
            self.send_json({
                "error": f"macOS Permission Denied for '{images_dir}'. Grant your Terminal 'Full Disk Access' in System Settings > Privacy & Security, or move the folder to a standard location."
            }, status=403)
            return
        except Exception as e:
            self.send_json({"error": f"Failed reading images folder: {e}"}, status=400)
            return

        files = []
        for item in raw_items:
            ext = os.path.splitext(item)[1].lower()
            if ext not in SUPPORTED_IMAGE_EXTS or item.startswith("."):
                continue

            full_image_path = os.path.join(images_dir, item)
            base_name = os.path.splitext(item)[0]
            transcript_path = os.path.join(transcript_dir, f"{base_name}.txt") if transcript_dir else None

            try:
                already_done = bool(
                    transcript_path
                    and os.path.exists(transcript_path)
                    and os.path.getsize(transcript_path) > 0
                )
                size = os.path.getsize(full_image_path)
            except Exception:
                already_done = False
                size = 0

            files.append({
                "filename": item,
                "filepath": full_image_path,
                "size": size,
                "alreadyDone": already_done,
            })

        self.send_json({
            "success": True,
            "imagesDir": images_dir,
            "transcriptDir": transcript_dir,
            "files": files,
        })

    def _handle_save_transcript(self, body):
        transcript_dir = os.path.expanduser(body.get("transcriptDir", "").strip())
        filename = safe_basename(body.get("filename", "").strip())
        content = body.get("content", "")

        if not transcript_dir:
            self.send_json({"error": "transcriptDir required"}, status=400)
            return
        if not filename:
            self.send_json({"error": "invalid filename"}, status=400)
            return

        os.makedirs(transcript_dir, exist_ok=True)
        txt_path = os.path.join(transcript_dir, filename)

        fd, tmp_path = tempfile.mkstemp(prefix=filename + ".", suffix=".tmp", dir=transcript_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
            os.replace(tmp_path, txt_path)
        except Exception as e:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            self.send_json({"error": f"Failed to save: {e}"}, status=500)
            return

        self.send_json({"success": True, "savedPath": txt_path})


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Handle each request in a new thread so concurrent GETs/POSTs don't serialize."""
    daemon_threads = True
    allow_reuse_address = True


def run_server():
    print("=" * 60)
    print("Gemini Image Transcriber Local Bridge")
    print(f"Listening on http://127.0.0.1:{PORT}")
    print(f"Supported image types: {', '.join(sorted(SUPPORTED_IMAGE_EXTS))}")
    print("=" * 60)
    server_address = ("127.0.0.1", PORT)
    httpd = ThreadedHTTPServer(server_address, FileBridgeHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping bridge server...")
        httpd.server_close()


if __name__ == "__main__":
    run_server()
