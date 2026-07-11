"""Summary/gate builder for run_all.sh — pure functions, unit-testable.

run_all.sh tees every step's stdout+stderr to eval/logs/run_all/<step>.out
and records each step's shell status. This module parses THOSE log files
(never the live terminal) into headline metric values and derives a
four-state gate per step:

  "pass"    — the step ran, exited zero, and its metrics parsed
  "fail"    — the step ran and its own threshold said no (--require-exact
              failures, clean FP rate over --max-fp-rate)
  "skipped" — the step was never launched: a DECLARED precondition
              (missing corpus/venv, GF_SKIP_BENCHMARKS=1, GF_SKIP_RESTART=1)
              failed before the run
  "error"   — the step RAN but exited nonzero without a threshold verdict,
              or its metrics could not be parsed from its log

A missing/unparseable metric on a step that ran is "error", NEVER "skipped".
overall_gate is the GF_GATE=1 predicate: any "fail" or "error" fails the
run; "skipped" alone never does (skips are declared, errors are not).

CLI (invoked by run_all.sh):
  python3 lib_summary.py <status_tsv> <log_dir> <out_json> \
      <timestamp> <bridge_commit> <bridge_url> [--gate]

<status_tsv> lines: "<step>\t<status>\t<detail>". Exit code is 0 unless
--gate is given and the overall gate fails.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Steps that carry no metrics by design (infrastructure, not instruments).
_INFRA_STEPS = {"restart"}

# Markers proving a nonzero exit was the step's OWN threshold verdict
# (gate "fail") rather than a crash (gate "error").
_THRESHOLD_FAIL_MARKERS = {
    "golden": "--require-exact:",
    "clean": "FAIL: fp_rate",
}

# Markers proving the step could not MEASURE (request errors): a gate that
# could not measure is "error", not "fail", even when the headline metric
# parsed (e.g. golden 0/125 against an unreachable bridge still prints its
# summary line + the --require-exact verdict).
_REQUEST_ERROR_MARKERS = {
    "golden": "] ERROR ",
}

_ARTIFACTS = [
    "results.json",
    "results.latency.json",
    "clean_corpus.runs.json",
    "benchmarks/conll14/conll14_results.json",
    "benchmarks/bea19/bea19_results.json",
    "jfleg_results.json",
    "calibration_results.json",
]


def _parse_golden(text: str) -> dict | None:
    m = re.search(r"GEC eval\s+—\s+(\d+)/(\d+) exact-match", text)
    if not m:
        return None
    return {"passed": int(m.group(1)), "total": int(m.group(2))}


def _parse_clean(text: str) -> dict | None:
    m = re.search(r"Clean-text FP eval — (\d+)/(\d+) flagged \(([\d.]+)%\)", text)
    if not m:
        return None
    return {
        "fp_count": int(m.group(1)),
        "total": int(m.group(2)),
        "rate": float(m.group(3)),
    }


def _parse_prf(label: str, text: str) -> dict | None:
    m = re.search(rf"{label}\s+F0\.5 = ([\d.]+)\s+\(P=([\d.]+) R=([\d.]+)\)", text)
    if not m:
        return None
    return {
        "p": float(m.group(2)),
        "r": float(m.group(3)),
        "f05": float(m.group(1)),
    }


def _parse_jfleg(text: str) -> dict | None:
    # Multi-run logs print one GLEU line per run; the LAST is the run
    # jfleg_eval.py itself reports as final.
    matches = re.findall(r"corpus GLEU = ([\d.]+)", text)
    if not matches:
        return None
    return {"gleu": float(matches[-1])}


def _parse_calibration(text: str) -> dict | None:
    matches = re.findall(r"ECE = ([\d.]+)", text)
    if not matches:
        return None
    return {"ece": float(matches[-1])}


_PARSERS = {
    "golden": _parse_golden,
    "clean": _parse_clean,
    "conll14": lambda t: _parse_prf("CoNLL-2014-test", t),
    "bea19": lambda t: _parse_prf("BEA-2019-dev", t),
    "jfleg": _parse_jfleg,
    "calibration": _parse_calibration,
}


def _read_log(info: dict) -> str:
    path = info.get("log")
    if not path:
        return ""
    p = Path(path)
    if not p.exists():
        return ""
    return p.read_text(errors="replace")


def _gate_step(name: str, info: dict) -> tuple[str, dict | None]:
    """Return (gate, metrics) for one step."""
    status = info.get("status", "")
    if status == "skipped":
        return "skipped", None

    ran_ok = status == "ok"
    if name in _INFRA_STEPS:
        return ("pass", None) if ran_ok else ("error", None)

    text = _read_log(info)
    parser = _PARSERS.get(name)
    metrics = parser(text) if parser else None
    if parser and metrics is None:
        # The step ran but its headline never made it to the log.
        return "error", None
    if ran_ok:
        return "pass", metrics
    error_marker = _REQUEST_ERROR_MARKERS.get(name)
    if error_marker and error_marker in text:
        return "error", metrics
    marker = _THRESHOLD_FAIL_MARKERS.get(name)
    if marker and marker in text:
        return "fail", metrics
    return "error", metrics


def build_summary(steps: dict) -> dict:
    """steps: {name: {"status": str, "detail": str, "log": path|None}}."""
    out: dict = {"steps": {}}
    for name, info in steps.items():
        gate, metrics = _gate_step(name, info)
        entry: dict = {
            "status": info.get("status", ""),
            "detail": info.get("detail", ""),
            "gate": gate,
        }
        if metrics is not None:
            entry["metrics"] = metrics
        if info.get("log"):
            entry["log"] = info["log"]
        out["steps"][name] = entry
    return out


def overall_gate(summary: dict) -> bool:
    """True iff no step gate is "fail" or "error" ("skipped" never fails)."""
    return all(s["gate"] not in ("fail", "error") for s in summary["steps"].values())


def _main(argv: list[str]) -> int:
    gate_mode = "--gate" in argv
    args = [a for a in argv if a != "--gate"]
    if len(args) != 6:
        print(__doc__, file=sys.stderr)
        return 2
    status_tsv, log_dir, out_json, timestamp, bridge_commit, bridge_url = args

    steps: dict = {}
    for line in Path(status_tsv).read_text().splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 2)
        name = parts[0]
        status = parts[1] if len(parts) > 1 else ""
        detail = parts[2] if len(parts) > 2 else ""
        log_path = Path(log_dir) / f"{name}.out"
        steps[name] = {
            "status": status,
            "detail": detail,
            "log": str(log_path) if log_path.exists() else None,
        }

    summary = build_summary(steps)
    ok = overall_gate(summary)
    payload = {
        "timestamp": timestamp,
        "bridge_commit": bridge_commit,
        "bridge_url": bridge_url,
        "artifacts": _ARTIFACTS,
        "steps": summary["steps"],
        "overall_gate": "pass" if ok else "fail",
    }
    Path(out_json).write_text(json.dumps(payload, indent=2) + "\n")
    print(f"overall gate: {'pass' if ok else 'FAIL'}")
    if gate_mode and not ok:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
