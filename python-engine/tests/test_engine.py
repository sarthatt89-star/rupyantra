import json
import pathlib
import re
import time

import pytest

from src import __version__, engine

PRICES = [100, 102, 101, 105, 107, 104, 110, 108, 112, 115, 113, 118, 120]
META = {"engine", "function", "executed", "success", "execution_id", "duration_ms", "version"}


def test_startup_info_is_real():
    i = engine.info()
    assert i["engine"] == "python" and i["version"] == __version__
    assert set(i["functions"]) == set(engine.REGISTRY) and i["functions"] == sorted(i["functions"])


def test_success_envelope_has_real_metadata():
    r = engine.execute("price_analysis", {"prices": PRICES})
    assert META <= set(r)
    assert (r["engine"], r["function"], r["executed"], r["success"], r["version"]) == ("python", "price_analysis", True, True, __version__)
    assert re.fullmatch(r"[0-9a-f]{32}", r["execution_id"])
    assert isinstance(r["duration_ms"], float) and r["duration_ms"] >= 0
    assert r["result"]["observations"] == len(PRICES) and "error" not in r


def test_every_execution_gets_its_own_id_and_a_measured_time():
    ids = {engine.execute("max_drawdown", {"prices": PRICES})["execution_id"] for _ in range(50)}
    assert len(ids) == 50
    big = engine.execute("price_analysis", {"prices": [100 + (i % 7) for i in range(50_000)]})
    small = engine.execute("max_drawdown", {"prices": PRICES})
    assert big["duration_ms"] > small["duration_ms"]


def test_not_approved_functions_are_not_executed():
    for name in ("run_shell", "eval", "exec", "__import__('os').system('id')", "os.system", "", None, 5, ["price_analysis"], "x" * 500):
        r = engine.execute(name, {})
        assert r["executed"] is False and r["success"] is False and r["error"]["code"] == "NOT_APPROVED", name
        assert META <= set(r)
    assert engine.execute("x" * 500, {})["function"] is None


def test_argument_problems_are_bad_requests_and_not_executed():
    assert engine.execute("max_drawdown", {})["error"]["code"] == "BAD_REQUEST"
    r = engine.execute("max_drawdown", {"prices": PRICES, "eval": "1+1"})
    assert r["error"]["code"] == "BAD_REQUEST" and r["executed"] is False
    assert engine.execute("max_drawdown", [1, 2])["error"]["code"] == "BAD_REQUEST"
    assert engine.execute("max_drawdown", "prices")["error"]["code"] == "BAD_REQUEST"


def test_invalid_values_are_reported_as_executed_but_unsuccessful():
    r = engine.execute("max_drawdown", {"prices": [100, 0, 90]})
    assert r["executed"] is True and r["success"] is False and r["error"]["code"] == "INVALID_INPUT"
    assert "prices[1]" in r["error"]["message"] and "result" not in r


@pytest.mark.parametrize("bad", [[], None, "abc", [1], [float("nan"), 1], [float("inf"), 1], [-5, 1], [True, 2], [[1], [2]]])
def test_empty_and_malformed_datasets_fail_cleanly(bad):
    r = engine.execute("price_analysis", {"prices": bad})
    assert r["success"] is False and r["error"]["code"] == "INVALID_INPUT"


def test_internal_failures_do_not_leak_details(monkeypatch):
    def boom(**kwargs):
        raise RuntimeError("secret path /etc/passwd")
    monkeypatch.setitem(engine.REGISTRY, "max_drawdown", (boom, ("prices",), ()))
    r = engine.execute("max_drawdown", {"prices": PRICES})
    assert r["success"] is False and r["error"] == {"code": "INTERNAL_ERROR", "message": "calculation failed"}
    assert "secret" not in json.dumps(r)


def test_non_finite_results_are_never_returned(monkeypatch):
    monkeypatch.setitem(engine.REGISTRY, "max_drawdown", (lambda prices: {"x": float("nan")}, ("prices",), ()))
    r = engine.execute("max_drawdown", {"prices": PRICES})
    assert r["success"] is False and r["error"]["code"] == "NON_FINITE_RESULT"


def test_large_dataset_runs_and_one_more_is_refused():
    n = 100_000
    p = [100.0 * (1.0001 ** i) * (1 + 0.001 * ((i * 7919) % 13 - 6) / 6) for i in range(n)]
    t = time.perf_counter()
    r = engine.execute("price_analysis", {"prices": p})
    assert r["success"] is True and r["result"]["observations"] == n
    assert time.perf_counter() - t < 10
    assert engine.execute("price_analysis", {"prices": p + [100.0]})["error"]["code"] == "INVALID_INPUT"


def test_same_input_same_numbers():
    a = engine.execute("risk_report", {"prices": PRICES})
    b = engine.execute("risk_report", {"prices": PRICES})
    assert a["result"] == b["result"] and a["execution_id"] != b["execution_id"]


def test_json_door():
    ok = json.loads(engine.execute_json(json.dumps({"function": "max_drawdown", "args": {"prices": PRICES}})))
    assert ok["success"] is True and ok["executed"] is True
    for text, code in (("not json", "BAD_REQUEST"), ("[1,2]", "BAD_REQUEST"), ('{"args":{}}', "BAD_REQUEST"),
                       ("x" * (engine.MAX_REQUEST_BYTES + 1), "TOO_LARGE"), (None, "BAD_REQUEST"), (123, "BAD_REQUEST")):
        r = json.loads(engine.execute_json(text))
        assert r["error"]["code"] == code and r["executed"] is False, text
    nan = json.loads(engine.execute_json('{"function":"max_drawdown","args":{"prices":[100,NaN,90]}}'))
    assert nan["success"] is False and nan["error"]["code"] == "INVALID_INPUT"
    deep = "[" * 100000 + "]" * 100000
    assert json.loads(engine.execute_json(deep))["success"] is False


def test_engines_stay_separate():
    """C++ does deterministic calculators, Julia simulation/optimisation: Python must not duplicate them."""
    banned = ("emi", "sip", "lumpsum", "monte", "optimi", "frontier", "amortiz", "cagr_calc")
    for name in engine.REGISTRY:
        assert not any(b in name for b in banned), name


def test_no_dangerous_calls_in_the_engine_source():
    src_dir = pathlib.Path(__file__).resolve().parent.parent / "src"
    pattern = re.compile(r"\b(eval|exec|compile|__import__|pickle|marshal|subprocess|os\.system|os\.popen|importlib)\b\s*[\(\.]?")
    for f in src_dir.glob("*.py"):
        code = "\n".join(line.split("#")[0] for line in f.read_text().splitlines())
        code = re.sub(r'""".*?"""', "", code, flags=re.S)
        code = re.sub(r"\"[^\"\n]*\"", "", code)
        assert not pattern.search(code), f"{f.name} uses a forbidden call"


def test_only_standard_library_is_imported():
    import sys
    std = set(sys.stdlib_module_names)
    src_dir = pathlib.Path(__file__).resolve().parent.parent / "src"
    for f in src_dir.glob("*.py"):
        for m in re.finditer(r"^\s*(?:from|import)\s+([A-Za-z_][\w]*)", f.read_text(), flags=re.M):
            assert m.group(1) in std, f"{f.name} imports non-standard module {m.group(1)}"
