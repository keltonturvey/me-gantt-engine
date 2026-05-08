#!/usr/bin/env python3
"""
Local dev server for me-gantt-engine.

Serves static files from the project root, plus an ICS proxy that fetches
Outlook calendars server-side so the browser doesn't hit CORS errors.

Any env var matching <NAME>_ICS_URL is exposed as /ics/<name> (lowercased).
Examples:
  HOLIDAY_ICS_URL  →  /ics/holiday
  FAMILY_ICS_URL   →  /ics/family
  KJT_ICS_URL      →  /ics/kjt

Usage:
    python3 dev-server.py
    # then open http://localhost:8000

Override port: PORT=9000 python3 dev-server.py
"""

import http.server
import os
import socketserver
import sys
import time
import urllib.request

PORT = int(os.environ.get("PORT", "8000"))
CACHE_TTL_SECONDS = 300
ICS_SUFFIX = "_ICS_URL"


def load_env(path=".env"):
    env = {}
    try:
        with open(path) as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return env


ENV = load_env()
_cache = {}  # url -> (timestamp, body)


def build_ics_routes(env):
    routes = {}
    for key, value in env.items():
        if not key.endswith(ICS_SUFFIX) or not value:
            continue
        name = key[: -len(ICS_SUFFIX)].lower()
        if name:
            routes[f"/ics/{name}"] = value
    return routes


ICS_ROUTES = build_ics_routes(ENV)


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
        if self.path in ICS_ROUTES:
            return self._proxy_ics(ICS_ROUTES[self.path])
        if self.path.startswith("/ics/"):
            self.send_error(404, f"No ICS route for {self.path}")
            return
        return super().do_GET()

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
        print(f"Serving http://localhost:{PORT}")
        if ICS_ROUTES:
            print("ICS routes:")
            for route in sorted(ICS_ROUTES):
                print(f"  {route}")
        else:
            print("  (no *_ICS_URL entries in .env — no /ics routes registered)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping.")


if __name__ == "__main__":
    sys.exit(main())
