"""Small secured HTTP service around the Python engine (standard library only).

    PY_SERVICE_TOKEN=<long random secret> python3 server.py          # listens on 127.0.0.1:8080

  GET  /health  -> {"engine":"python","version":...}      (no secrets, no calculation)
  POST /run     -> body {"function": "...", "args": {...}}  header  Authorization: Bearer <token>

Protection: bearer token (constant-time compare), request size limit, per-client rate limit, execution timeout
(SIGALRM, Unix main thread), only approved functions (src/engine.py), and logs that never contain request bodies.
Environment: PY_SERVICE_TOKEN (required), PY_SERVICE_HOST (default 127.0.0.1), PY_SERVICE_PORT (8080),
PY_TIMEOUT_SECONDS (20, max 60), PY_RATE_PER_MINUTE (60), PY_MAX_BODY_BYTES (2000000, max 5000000).

Deploying this publicly is a separate, deliberate step: put it behind HTTPS on a host you control. It is NOT deployed
automatically and Vercel is not assumed to run it.
"""

import hmac
import json
import os
import signal
import sys
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src import engine  # noqa: E402


class _Timeout(BaseException):
    """Derives from BaseException on purpose: the engine's own `except Exception` must never swallow a timeout."""


def _env_number(name, default, lo, hi):
    try:
        value = float(os.environ.get(name, default))
    except ValueError:
        value = float(default)
    return max(lo, min(hi, value))


class Settings:
    def __init__(self, token, timeout_seconds=20.0, rate_per_minute=60, max_body_bytes=2_000_000):
        if not token or len(token) < 16:
            raise ValueError("PY_SERVICE_TOKEN must be set and at least 16 characters long")
        self.token = token
        self.timeout_seconds = max(0.2, min(60.0, float(timeout_seconds)))
        self.rate_per_minute = max(1, int(rate_per_minute))
        self.max_body_bytes = max(1000, min(5_000_000, int(max_body_bytes)))

    @classmethod
    def from_env(cls):
        return cls(os.environ.get("PY_SERVICE_TOKEN", ""),
                   _env_number("PY_TIMEOUT_SECONDS", 20, 0.2, 60),
                   _env_number("PY_RATE_PER_MINUTE", 60, 1, 100000),
                   _env_number("PY_MAX_BODY_BYTES", 2_000_000, 1000, 5_000_000))


class Handler(BaseHTTPRequestHandler):
    settings = None            # set by make_server
    hits = None                # client -> recent request times
    server_version = "RupeyantraPython"
    sys_version = ""

    def log_message(self, fmt, *args):   # silence the default access log (it would include paths and client details)
        return

    def _log(self, status, function, started):
        sys.stderr.write("%s POST /run status=%d function=%s duration_ms=%.1f\n" % (
            time.strftime("%Y-%m-%dT%H:%M:%S"), status, function or "-", (time.perf_counter() - started) * 1000))

    def _send(self, status, payload):
        body = json.dumps(payload, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, **engine.info(), "timeout_enforced": threading.current_thread() is threading.main_thread()})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def _allowed(self):
        client = self.client_address[0]
        now = time.monotonic()
        q = self.hits[client]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.settings.rate_per_minute:
            return False
        q.append(now)
        return True

    def do_POST(self):
        t0 = time.perf_counter()
        s = self.settings
        if self.path != "/run":
            return self._send(404, {"ok": False, "error": "not found"})
        supplied = self.headers.get("Authorization", "")
        expected = "Bearer " + s.token
        if not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
            self._log(401, None, t0)
            return self._send(401, {"ok": False, "error": "unauthorized"})
        if not self._allowed():
            self._log(429, None, t0)
            return self._send(429, engine.failure(None, "RATE_LIMITED", "too many requests; try again shortly"))
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0:
            self._log(400, None, t0)
            return self._send(400, engine.failure(None, "BAD_REQUEST", "Content-Length is required"))
        if length > s.max_body_bytes:
            self._log(413, None, t0)
            return self._send(413, engine.failure(None, "TOO_LARGE", "request is too large"))
        raw = self.rfile.read(length)
        function = None
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict) and isinstance(parsed.get("function"), str):
                function = parsed["function"][:80]
        except (ValueError, RecursionError):
            pass
        use_timer = threading.current_thread() is threading.main_thread() and hasattr(signal, "setitimer")

        def on_alarm(signum, frame):
            raise _Timeout()

        try:
            if use_timer:
                signal.signal(signal.SIGALRM, on_alarm)
                signal.setitimer(signal.ITIMER_REAL, s.timeout_seconds)
            answer = engine.execute_json(raw)
            status = 200
        except _Timeout:
            answer = json.dumps(engine.failure(function, "TIMEOUT", "the calculation took too long and was stopped", executed=True))
            status = 504
        finally:
            if use_timer:
                signal.setitimer(signal.ITIMER_REAL, 0)
        self._log(status, function, t0)
        body = answer.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def make_server(host, port, settings):
    handler = type("BoundHandler", (Handler,), {"settings": settings, "hits": defaultdict(deque)})
    return HTTPServer((host, port), handler)


def main():
    try:
        settings = Settings.from_env()
    except ValueError as e:
        sys.stderr.write("refusing to start: %s\n" % e)
        return 2
    host = os.environ.get("PY_SERVICE_HOST", "127.0.0.1")
    port = int(_env_number("PY_SERVICE_PORT", 8080, 1, 65535))
    server = make_server(host, port, settings)
    sys.stderr.write("rupeyantra python service on %s:%d (version %s)\n" % (host, server.server_address[1], engine.info()["version"]))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
