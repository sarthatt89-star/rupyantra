"""The two real doors: the command line (run.py) and the secured HTTP service (server.py), each started as a real process."""

import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = "test-token-0123456789abcdef"
HEAVY = {"function": "backtest_forecast",
         "args": {"values": [100 + 0.5 * i + (i % 7) for i in range(5000)], "method": "holt", "max_origins": 100}}


def run_cli(payload, raw=None):
    text = raw if raw is not None else json.dumps(payload)
    p = subprocess.run([sys.executable, os.path.join(ROOT, "run.py")], input=text, capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def check_evidence(r, function):
    assert r["engine"] == "python" and r["function"] == function
    assert r["executed"] is True
    assert re.fullmatch(r"[0-9a-f]{32}", r["execution_id"])
    assert isinstance(r["duration_ms"], float) and r["duration_ms"] >= 0
    assert re.fullmatch(r"\d+\.\d+\.\d+", r["version"])


def test_cli_runs_a_real_calculation_with_real_metadata():
    r = run_cli({"function": "describe_series", "args": {"values": [1, 2, 3, 4, 5]}})
    check_evidence(r, "describe_series")
    assert r["success"] is True and r["result"]["summary"]["mean"] == 3.0


def test_cli_execution_ids_are_unique_and_durations_are_measured():
    a = run_cli({"function": "describe_series", "args": {"values": [1, 2, 3]}})
    b = run_cli({"function": "describe_series", "args": {"values": [1, 2, 3]}})
    assert a["execution_id"] != b["execution_id"]
    big = run_cli({"function": "describe_series", "args": {"values": [float(i % 97) for i in range(100000)]}})
    assert big["duration_ms"] > 0 and big["success"] is True


@pytest.mark.parametrize("payload,code", [
    ({"function": "os.system", "args": {}}, "NOT_APPROVED"),
    ({"function": "__import__('os')", "args": {}}, "NOT_APPROVED"),
    ({"function": "describe_series", "args": {"values": [1, 2], "eval": "1+1"}}, "BAD_REQUEST"),
    ({"function": "describe_series", "args": {}}, "BAD_REQUEST"),
    ({"function": "describe_series", "args": {"values": ["a"]}}, "INVALID_INPUT"),
    ({"function": "forecast", "args": {"values": [1, 2, 3]}}, "INVALID_INPUT"),
])
def test_cli_refusals_are_honest(payload, code):
    r = run_cli(payload)
    assert r["success"] is False and r["error"]["code"] == code
    assert r["executed"] is (code == "INVALID_INPUT")        # only a function that really started is reported as executed


def test_cli_garbage_in_is_safe():
    assert run_cli(None, raw="not json")["error"]["code"] == "BAD_REQUEST"
    assert run_cli(None, raw="[1,2,3]")["error"]["code"] == "BAD_REQUEST"
    assert run_cli(None, raw='{"function": 5}')["error"]["code"] == "NOT_APPROVED"
    assert run_cli(None, raw='{"function":"describe_series","args":{"values":[NaN]}}')["error"]["code"] == "INVALID_INPUT"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Service:
    def __init__(self, **env):
        self.port = free_port()
        full = dict(os.environ, PY_SERVICE_TOKEN=TOKEN, PY_SERVICE_PORT=str(self.port), PY_SERVICE_HOST="127.0.0.1")
        full.update({k: str(v) for k, v in env.items()})
        self.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], env=full,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            try:
                self.get("/health")
                return
            except Exception:  # noqa: BLE001
                time.sleep(0.05)
        self.stop()
        raise RuntimeError("service did not start")

    def request(self, method, path, body=None, token=TOKEN, headers=None):
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method)
        if token is not None:
            req.add_header("Authorization", "Bearer " + token)
        req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def get(self, path):
        return self.request("GET", path, token=None)

    def post(self, body, **kw):
        return self.request("POST", "/run", body, **kw)

    def stop(self):
        self.proc.terminate()
        try:
            out, err = self.proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            out, err = self.proc.communicate()
        return err


@pytest.fixture
def service():
    s = Service()
    yield s
    s.stop()


def test_server_refuses_to_start_without_a_strong_token():
    for token in ("", "short"):
        env = dict(os.environ, PY_SERVICE_TOKEN=token, PY_SERVICE_PORT=str(free_port()))
        p = subprocess.run([sys.executable, os.path.join(ROOT, "server.py")], env=env, capture_output=True, text=True, timeout=20)
        assert p.returncode == 2 and "refusing to start" in p.stderr


def test_health_needs_no_token_and_leaks_nothing_secret(service):
    status, body = service.get("/health")
    assert status == 200 and body["engine"] == "python" and "describe_series" in body["functions"]
    assert TOKEN not in json.dumps(body)
    assert service.get("/nothing")[0] == 404


def test_run_needs_the_right_token(service):
    req = {"function": "describe_series", "args": {"values": [1, 2, 3]}}
    assert service.post(req, token=None)[0] == 401
    assert service.post(req, token="wrong-token-0123456789")[0] == 401
    assert service.post(req, token=TOKEN + "x")[0] == 401
    status, body = service.post(req)
    assert status == 200 and body["success"] is True
    check_evidence(body, "describe_series")


def test_run_gives_honest_failures(service):
    status, body = service.post({"function": "eval", "args": {}})
    assert status == 200 and body["success"] is False and body["error"]["code"] == "NOT_APPROVED"
    status, body = service.post(b"{broken")
    assert status == 200 and body["error"]["code"] == "BAD_REQUEST"
    status, body = service.request("POST", "/run", b"{}", headers={"Content-Length": "abc"})
    assert status in (400, 401) or body["success"] is False


def test_oversized_request_is_refused_before_it_is_read():
    s = Service(PY_MAX_BODY_BYTES=1000)
    try:
        status, body = s.post({"function": "describe_series", "args": {"values": list(range(2000))}})
        assert status == 413 and body["error"]["code"] == "TOO_LARGE" and body["executed"] is False
        assert s.post({"function": "describe_series", "args": {"values": [1, 2, 3]}})[0] == 200
    finally:
        s.stop()


def test_rate_limit():
    s = Service(PY_RATE_PER_MINUTE=3)
    try:
        req = {"function": "describe_series", "args": {"values": [1, 2, 3]}}
        codes = [s.post(req)[0] for _ in range(5)]
        assert codes == [200, 200, 200, 429, 429]
        assert s.get("/health")[0] == 200                       # health is not rate limited
    finally:
        s.stop()


def test_timeout_really_stops_a_slow_calculation():
    s = Service(PY_TIMEOUT_SECONDS=0.3)
    try:
        t0 = time.perf_counter()
        status, body = s.post(HEAVY)
        elapsed = time.perf_counter() - t0
        assert status == 504 and body["error"]["code"] == "TIMEOUT" and body["success"] is False
        assert body["executed"] is True and body["function"] == "backtest_forecast"
        assert elapsed < 5
        assert s.post({"function": "describe_series", "args": {"values": [1, 2, 3]}})[1]["success"] is True   # still alive
    finally:
        s.stop()


def test_logs_never_contain_request_content_or_the_token():
    s = Service()
    try:
        s.post({"function": "describe_series", "args": {"values": [1, 2, 3], "secret_marker_12345": 1}})
        s.post({"function": "describe_series", "args": {"values": [987654.321, 2, 3]}})
        s.post({"function": "describe_series", "args": {"values": [1]}}, token="wrong-token-0123456789")
    finally:
        err = s.stop()
    assert "status=200" in err and "status=401" in err
    assert "secret_marker_12345" not in err and "987654" not in err and TOKEN not in err and "wrong-token" not in err
