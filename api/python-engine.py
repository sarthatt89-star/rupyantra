"""Rupeyantra Python engine as a Vercel function  (/api/python-engine).

Alag server nahi chahiye: Vercel isi repo se ise chalata hai.
  GET  /api/python-engine           -> health (koi secret nahi)
  POST /api/python-engine           -> {"function": "...", "args": {...}}   (Authorization: Bearer <PY_SERVICE_TOKEN>)
Vercel me env PY_SERVICE_TOKEN (16+ akshar) set karna zaroori hai; bina uske ye har request ko mana kar deta hai.
"""

import hmac
import json
import os
import sys
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
for cand in (os.path.join(HERE, "..", "python-engine"), os.path.join(HERE, "python-engine"), os.path.join(os.getcwd(), "python-engine")):
    if os.path.isdir(os.path.join(cand, "src")):
        sys.path.insert(0, cand)
        break

from src import engine  # noqa: E402

MAX_BODY = 1_000_000
RATE_PER_MINUTE = 60
_hits = defaultdict(deque)


def _token():
    t = os.environ.get("PY_SERVICE_TOKEN", "")
    return t if len(t) >= 16 else ""


def _rate_ok(client):
    now = time.monotonic()
    q = _hits[client]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= RATE_PER_MINUTE:
        return False
    q.append(now)
    if len(_hits) > 5000:
        _hits.pop(next(iter(_hits)), None)
    return True


class handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # request ki detail log me nahi
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200, {"ok": True, "configured": bool(_token()), **engine.info()})

    def do_POST(self):
        token = _token()
        if not token:
            return self._send(503, {"ok": False, "error": "PY_SERVICE_TOKEN set nahi hai"})
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied.encode("utf-8"), ("Bearer " + token).encode("utf-8")):
            return self._send(401, {"ok": False, "error": "unauthorized"})
        client = (self.headers.get("x-forwarded-for") or self.client_address[0]).split(",")[0].strip()
        if not _rate_ok(client):
            return self._send(429, engine.failure(None, "RATE_LIMITED", "too many requests; try again shortly"))
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0:
            return self._send(400, engine.failure(None, "BAD_REQUEST", "Content-Length is required"))
        if length > MAX_BODY:
            return self._send(413, engine.failure(None, "TOO_LARGE", "request is too large"))
        raw = self.rfile.read(length)
        try:
            answer = engine.execute_json(raw)
        except Exception:
            return self._send(500, engine.failure(None, "INTERNAL", "engine error"))
        out = answer.encode("utf-8") if isinstance(answer, str) else answer
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)
