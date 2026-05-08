#!/usr/bin/env python3
"""
Local dev server for me-gantt-engine.

Reads `config.json` (a single gitignored file) for everything the app needs:
Trello creds, board IDs, and the list of calendars (with real Outlook URLs).

  - Each calendar's URL is mounted at /ics/<key>, so the browser fetches
    via the proxy and never sees the upstream Outlook URL.
  - /config.js is generated on the fly with the safe subset of config —
    Trello creds + board IDs pass through; calendar URLs are rewritten to
    /ics/<key> before reaching the browser.

Usage:
    python3 dev-server.py
    # then open http://localhost:8000

Override port: PORT=9000 python3 dev-server.py
Override config path: CONFIG=other.json python3 dev-server.py
"""

import http.server
import json
import os
import socketserver
import sys
import time
import urllib.request

PORT = int(os.environ.get("PORT", "8000"))
CONFIG_PATH = os.environ.get("CONFIG", "config.json")
CACHE_TTL_SECONDS = 300


def load_config(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"ERROR: {path} not found. Create it next to dev-server.py.")
        sys.exit(1)
    except json.JSONDecodeError as err:
        print(f"ERROR: {path} is not valid JSON: {err}")
        sys.exit(1)


CONFIG = load_config(CONFIG_PATH)
CALENDARS = CONFIG.get("calendars", []) or []
ICS_ROUTES = {
    f"/ics/{cal['key']}": cal["url"]
    for cal in CALENDARS
    if cal.get("key") and cal.get("url")
}

_cache = {}  # url -> (timestamp, body)


def build_browser_config():
    """Strip secrets the browser shouldn't see (real Outlook URLs)."""
    safe_calendars = [
        {
            "key": cal.get("key"),
            "label": cal.get("label", cal.get("key", "")),
            "color": cal.get("color", "#5e6c84"),
            "url": f"/ics/{cal['key']}",
        }
        for cal in CALENDARS
        if cal.get("key")
    ]
    return {
        "trelloKey": CONFIG.get("trelloKey", ""),
        "trelloToken": CONFIG.get("trelloToken", ""),
        "ME_BoardId": CONFIG.get("ME_BoardId", ""),
        "LRL_BoardId": CONFIG.get("LRL_BoardId", ""),
        "calendars": safe_calendars,
    }


def fetch_ics(url):
    now = time.time()
    cached = _cache.get(url)
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]
    req = urllib.request.Request(
        url, headers={"User-Agent": "me-gantt-engine-dev/1.0"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = resp.read()
    _cache[url] = (now, body)
    return body


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/config.js", "/config.js?"):
            return self._serve_config_js()
        if self.path in ICS_ROUTES:
            return self._proxy_ics(ICS_ROUTES[self.path])
        if self.path.startswith("/ics/"):
            self.send_error(404, f"No ICS route for {self.path}")
            return
        return super().do_GET()

    def _serve_config_js(self):
        payload = build_browser_config()
        body = (
            "window.ME_GANTT_CONFIG = "
            + json.dumps(payload, separators=(",", ":"))
            + ";\n"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/javascript; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy_ics(self, url):
        try:
            body = fetch_ics(url)
        except Exception as err:
            self.send_error(502, f"Upstream fetch failed: {err}")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/calendar; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Serving http://localhost:{PORT}  (config: {CONFIG_PATH})")
        if ICS_ROUTES:
            print("ICS routes:")
            for route in sorted(ICS_ROUTES):
                print(f"  {route}")
        else:
            print("  (no calendars in config — no /ics routes registered)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping.")


if __name__ == "__main__":
    sys.exit(main())
