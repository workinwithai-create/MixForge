#!/usr/bin/env python3
import argparse
import http.server
import json
import os
import pathlib
import socketserver
import subprocess
import sys
import threading
import webbrowser

SERVICE = "pipe-dreams-dream-mix"
REPO = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_PORT = 8765

def keychain_secret(service):
    proc = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-a", os.environ.get("USER", ""), "-s", service, "-w"],
        text=True, capture_output=True,
    )
    return proc.stdout.strip() if proc.returncode == 0 else ""

class Handler(http.server.SimpleHTTPRequestHandler):
    token = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(REPO), **kwargs)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/__crew_token":
            payload = json.dumps({"token": self.token}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        if self.path.startswith("/__crew_token"):
            return
        super().log_message(fmt, *args)

def open_worker(url):
    chrome = "/Applications/Google Chrome.app"
    if pathlib.Path(chrome).exists():
        subprocess.run(["/usr/bin/open", "-na", "Google Chrome", "--args", "--app=" + url], check=False)
    else:
        webbrowser.open(url)

def main():
    parser = argparse.ArgumentParser(description="Pipe Dreams Dream Mix local browser worker")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    token = os.environ.get("PIPE_DREAMS_MIX_WORKER_TOKEN") or keychain_secret(SERVICE)
    if not token:
        print("No Dream Mix worker token found in macOS Keychain.", file=sys.stderr)
        return 2

    Handler.token = token
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), Handler) as server:
        url = f"http://127.0.0.1:{args.port}/?crew-worker=1"
        print(f"Dream Mix worker serving locally at {url}", flush=True)
        if not args.no_browser:
            threading.Timer(0.4, open_worker, args=(url,)).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

