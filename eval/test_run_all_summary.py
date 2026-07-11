"""Tests for lib_summary.py — the run_all.sh summary/gate builder.

build_summary consumes the per-step status map produced by run_all.sh plus
each step's tee'd log file, extracts headline metrics, and derives the
four-state gate ("pass" | "fail" | "skipped" | "error"). overall_gate is the
GF_GATE=1 predicate: any "fail" OR "error" step fails the run; "skipped"
alone never does (skips are declared, errors are not).
"""

from pathlib import Path

from lib_summary import build_summary, overall_gate

GOLDEN_PASS_LOG = """\
======================================================================
GrammarForge GEC eval  —  125/125 exact-match (100.0%)
======================================================================
"""

GOLDEN_FAIL_LOG = """\
======================================================================
GrammarForge GEC eval  —  123/125 exact-match (98.4%)
======================================================================

--require-exact: 2 failures → exit 1
"""

CLEAN_PASS_LOG = """\
Clean-text FP eval — 18/155 flagged (11.6%)
  golden     5/50
latency p50=140.1ms p95=300.0ms n=155
"""

CLEAN_FAIL_LOG = """\
Clean-text FP eval — 30/155 flagged (19.4%)
FAIL: fp_rate 19.4% > max 13.6%
"""

CONLL14_LOG = """\
============================================================
GrammarForge  CoNLL-2014-test  F0.5 = 60.53  (P=64.49 R=48.58)  over 1312 sents
============================================================
"""

BEA19_LOG = """\
============================================================
GrammarForge  BEA-2019-dev  F0.5 = 42.29  (P=42.93 R=39.91)  over 4384 sents  [regenerated-reference (errant-version-consistent)]
============================================================
"""

JFLEG_LOG = """\
============================================================
JFLEG dev  —  corpus GLEU = 0.4109  (+/- 0.0069)  95% CI [0.3911, 0.4308]  over 754 sentences
============================================================
"""

CALIBRATION_LOG = """\
============================================================
ECE = 0.0665
============================================================
"""


def _step(
    tmp_path: Path, name: str, status: str, log_text: str | None, detail: str = ""
):
    log = None
    if log_text is not None:
        log = tmp_path / f"{name}.out"
        log.write_text(log_text)
    return {"status": status, "detail": detail, "log": str(log) if log else None}


def test_build_summary_extracts_metrics_and_gates(tmp_path):
    steps = {
        "golden": _step(tmp_path, "golden", "ok", GOLDEN_PASS_LOG),
        "clean": _step(tmp_path, "clean", "ok", CLEAN_PASS_LOG),
        "conll14": _step(tmp_path, "conll14", "ok", CONLL14_LOG),
        "bea19": _step(tmp_path, "bea19", "ok", BEA19_LOG),
        "jfleg": _step(tmp_path, "jfleg", "ok", JFLEG_LOG),
        "calibration": _step(tmp_path, "calibration", "ok", CALIBRATION_LOG),
    }
    s = build_summary(steps)["steps"]
    assert s["golden"]["gate"] == "pass"
    assert s["golden"]["metrics"] == {"passed": 125, "total": 125}
    assert s["clean"]["gate"] == "pass"
    assert s["clean"]["metrics"] == {"fp_count": 18, "total": 155, "rate": 11.6}
    assert s["conll14"]["metrics"] == {"p": 64.49, "r": 48.58, "f05": 60.53}
    assert s["bea19"]["metrics"] == {"p": 42.93, "r": 39.91, "f05": 42.29}
    assert s["jfleg"]["metrics"] == {"gleu": 0.4109}
    assert s["calibration"]["metrics"] == {"ece": 0.0665}
    assert all(v["gate"] == "pass" for v in s.values())


def test_skipped_step_is_skipped_not_error(tmp_path):
    steps = {
        "golden": _step(tmp_path, "golden", "ok", GOLDEN_PASS_LOG),
        "conll14": _step(tmp_path, "conll14", "skipped", None, detail="data missing"),
    }
    s = build_summary(steps)["steps"]
    assert s["conll14"]["gate"] == "skipped"
    assert "metrics" not in s["conll14"] or s["conll14"]["metrics"] is None


def test_ran_but_unparseable_is_error_never_skipped(tmp_path):
    # The step RAN (launched, produced a log) but its metrics cannot be
    # parsed — e.g. the bridge was unreachable and the script only printed
    # request errors. That is "error", NEVER "skipped".
    steps = {
        "golden": _step(
            tmp_path, "golden", "fail(rc=1)", "request error: ConnectionError(...)\n"
        ),
    }
    s = build_summary(steps)["steps"]
    assert s["golden"]["gate"] == "error"


def test_golden_request_errors_are_error_even_with_headline(tmp_path):
    # Against an unreachable bridge run_eval.py still prints its headline
    # (0/125) and the --require-exact verdict — but a gate that could not
    # MEASURE is "error", never "fail".
    log = (
        "GrammarForge GEC eval  —  0/125 exact-match (0.0%)\n"
        "[ 1|spelling] ERROR ConnectionError(...)\n"
        "--require-exact: 125 failures → exit 1\n"
    )
    steps = {"golden": _step(tmp_path, "golden", "fail(rc=1)", log)}
    s = build_summary(steps)["steps"]
    assert s["golden"]["gate"] == "error"


def test_threshold_not_met_is_fail_not_error(tmp_path):
    steps = {
        "golden": _step(tmp_path, "golden", "fail(rc=1)", GOLDEN_FAIL_LOG),
        "clean": _step(tmp_path, "clean", "fail(rc=1)", CLEAN_FAIL_LOG),
    }
    s = build_summary(steps)["steps"]
    assert s["golden"]["gate"] == "fail"
    assert s["golden"]["metrics"] == {"passed": 123, "total": 125}
    assert s["clean"]["gate"] == "fail"
    assert s["clean"]["metrics"] == {"fp_count": 30, "total": 155, "rate": 19.4}


def test_nonzero_exit_without_threshold_marker_is_error(tmp_path):
    # Metrics parsed, exit nonzero, but no threshold-fail marker: the step
    # crashed AFTER printing its headline — that's an error, not a fail.
    log = CONLL14_LOG + "Traceback (most recent call last):\n  boom\n"
    steps = {"conll14": _step(tmp_path, "conll14", "fail(rc=1)", log)}
    s = build_summary(steps)["steps"]
    assert s["conll14"]["gate"] == "error"


def test_restart_step_has_no_metrics_requirement(tmp_path):
    steps = {
        "restart": _step(tmp_path, "restart", "ok", "restarted\n"),
        "golden": _step(tmp_path, "golden", "ok", GOLDEN_PASS_LOG),
    }
    s = build_summary(steps)["steps"]
    assert s["restart"]["gate"] == "pass"

    steps["restart"] = _step(tmp_path, "restart", "skipped", None, "GF_SKIP_RESTART=1")
    s = build_summary(steps)["steps"]
    assert s["restart"]["gate"] == "skipped"


def test_jfleg_multi_run_takes_last_gleu(tmp_path):
    log = (
        "JFLEG dev  —  corpus GLEU = 0.4000  (+/- 0.0069)  95% CI [0.39, 0.41]  over 754 sentences  [run 1/2]\n"
        "JFLEG dev  —  corpus GLEU = 0.4109  (+/- 0.0069)  95% CI [0.39, 0.43]  over 754 sentences  [run 2/2]\n"
    )
    steps = {"jfleg": _step(tmp_path, "jfleg", "ok", log)}
    s = build_summary(steps)["steps"]
    assert s["jfleg"]["metrics"] == {"gleu": 0.4109}


def test_overall_gate_pass_with_skips(tmp_path):
    steps = {
        "golden": _step(tmp_path, "golden", "ok", GOLDEN_PASS_LOG),
        "clean": _step(tmp_path, "clean", "ok", CLEAN_PASS_LOG),
        "conll14": _step(tmp_path, "conll14", "skipped", None, "GF_SKIP_BENCHMARKS=1"),
        "bea19": _step(tmp_path, "bea19", "skipped", None, "GF_SKIP_BENCHMARKS=1"),
    }
    assert overall_gate(build_summary(steps)) is True


def test_overall_gate_fails_on_any_fail_or_error(tmp_path):
    base = {
        "golden": _step(tmp_path, "golden", "ok", GOLDEN_PASS_LOG),
        "clean": _step(tmp_path, "clean", "fail(rc=1)", CLEAN_FAIL_LOG),
    }
    assert overall_gate(build_summary(base)) is False

    base["clean"] = _step(tmp_path, "clean", "fail(rc=2)", "boom, no metrics\n")
    assert overall_gate(build_summary(base)) is False
