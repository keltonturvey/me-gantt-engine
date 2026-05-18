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
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PORT = int(os.environ.get("PORT", "8000"))
CONFIG_PATH = os.environ.get("CONFIG", "config.json")
CACHE_TTL_SECONDS = 300
REPO_ROOT = Path(__file__).resolve().parent
MAIN_BRANCH = "main"


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


def _git(*args):
    return subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )


def git_pull_main():
    """Fast-forward `main` from `origin/main`. Returns a result dict.

    Refuses if checkout isn't on `main` or if the working tree is dirty.
    Never raises — all failures surface in the returned dict.
    """
    try:
        branch_proc = _git("rev-parse", "--abbrev-ref", "HEAD")
    except FileNotFoundError:
        return {"ok": False, "message": "git not found on PATH."}
    branch = branch_proc.stdout.strip()

    if branch != MAIN_BRANCH:
        return {
            "ok": False,
            "branch": branch,
            "message": f"Refusing to pull: checkout is on '{branch}', not '{MAIN_BRANCH}'.",
        }

    status_out = _git("status", "--porcelain", "--untracked-files=no").stdout
    if status_out.strip():
        dirty = [line[3:].strip() for line in status_out.splitlines() if line.strip()]
        return {
            "ok": False,
            "branch": branch,
            "dirty_files": dirty,
            "message": f"Refusing to pull: {len(dirty)} uncommitted file(s) in working tree.",
        }

    before = _git("rev-parse", "HEAD").stdout.strip()
    pull = _git("pull", "--ff-only", "origin", MAIN_BRANCH)
    if pull.returncode != 0:
        return {
            "ok": False,
            "branch": branch,
            "message": "git pull failed: " + (pull.stderr or pull.stdout).strip(),
        }

    after = _git("rev-parse", "HEAD").stdout.strip()
    if before == after:
        return {
            "ok": True,
            "branch": branch,
            "before": before,
            "after": after,
            "changed_files": [],
            "server_changed": False,
            "message": f"Already up to date ({after[:7]}).",
        }

    diff_out = _git("diff", "--name-only", before, after).stdout
    changed = [f for f in diff_out.splitlines() if f]
    return {
        "ok": True,
        "branch": branch,
        "before": before,
        "after": after,
        "changed_files": changed,
        "server_changed": "dev-server.py" in changed,
        "message": f"Pulled {before[:7]} → {after[:7]} ({len(changed)} file(s) changed).",
    }


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


def fetch_ics(url, bypass_cache=False):
    now = time.time()
    if not bypass_cache:
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
        path, _, query = self.path.partition("?")
        if path in ICS_ROUTES:
            bypass = "nocache=1" in query
            return self._proxy_ics(ICS_ROUTES[path], bypass_cache=bypass)
        if path.startswith("/ics/"):
            self.send_error(404, f"No ICS route for {path}")
            return
        return super().do_GET()

    def do_POST(self):
        if self.path == "/admin/pull":
            return self._admin_pull()
        self.send_error(404, f"No POST route for {self.path}")

    def _admin_pull(self):
        result = git_pull_main()
        body = json.dumps(result).encode("utf-8")
        status = 200 if result.get("ok") else 409
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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

    def _proxy_ics(self, url, bypass_cache=False):
        try:
            body = fetch_ics(url, bypass_cache=bypass_cache)
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
    pull_result = git_pull_main()
    tag = "ok" if pull_result.get("ok") else "warn"
    print(f"[startup pull / {tag}] {pull_result.get('message', '')}")
    if pull_result.get("server_changed"):
        print("  note: dev-server.py changed in pull — restart to apply.")

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
