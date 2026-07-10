import json

import dialect_matrix
from dialect_matrix import format_matrix, main, run_dialect, run_golden


def test_run_golden_all_pass():
    cases = [
        {"id": 1, "cat": "sva", "input": "She go home.", "golden": "She goes home."},
    ]

    def fake_correct(bridge_url, text, source="x"):
        # emits a suggestion that turns "go" -> "goes"
        idx = text.index("go")
        return {
            "suggestions": [
                {"span": {"start": idx, "end": idx + 2}, "replacement": "goes"}
            ]
        }

    summary = run_golden("http://x", cases, correct_fn=fake_correct)
    assert summary["n"] == 1
    assert summary["pass"] == 1
    assert summary["pass_rate"] == 1.0
    assert summary["by_cat"]["sva"] == {"pass": 1, "total": 1}


def test_run_golden_request_error_counts_as_fail():
    cases = [{"id": 1, "cat": "sva", "input": "x", "golden": "y"}]

    def raising_correct(bridge_url, text, source="x"):
        raise RuntimeError("boom")

    summary = run_golden("http://x", cases, correct_fn=raising_correct)
    assert summary["pass"] == 0
    assert summary["by_cat"]["sva"]["total"] == 1


def test_run_dialect_wires_golden_and_clean(monkeypatch):
    cases = [{"id": 1, "cat": "clean", "input": "fine.", "golden": "fine."}]

    def fake_correct(bridge_url, text, source="x"):
        return {"suggestions": []}

    def fake_clean_run(bridge_url, corpus_file):
        return [
            {
                "id": "c1",
                "register": "golden",
                "flagged": False,
                "models": [],
                "categories": [],
            }
        ]

    report = run_dialect(
        "american", "http://x", cases, "unused.jsonl",
        correct_fn=fake_correct, clean_runner=fake_clean_run,
    )
    assert report["dialect"] == "american"
    assert report["golden"]["pass"] == 1
    assert report["clean"]["total"] == 1
    assert report["clean"]["false_positives"] == 0


def test_format_matrix_includes_both_dialects():
    reports = [
        {
            "dialect": "american",
            "golden": {
                "pass": 120, "n": 125, "pass_rate": 0.96,
                "by_cat": {"sva": {"pass": 10, "total": 10}},
                "latency": {"p50_ms": 100.0},
            },
            "clean": {"false_positives": 5, "total": 155, "fp_rate": 0.032},
        },
        {
            "dialect": "british",
            "golden": {
                "pass": 118, "n": 125, "pass_rate": 0.944,
                "by_cat": {"sva": {"pass": 9, "total": 10}},
                "latency": {"p50_ms": 110.0},
            },
            "clean": {"false_positives": 18, "total": 155, "fp_rate": 0.1161},
        },
    ]
    out = format_matrix(reports)
    assert "american" in out and "british" in out
    assert "golden pass-rate" in out
    assert "clean FP-rate" in out


def test_main_end_to_end_mocked(tmp_path, monkeypatch):
    """No live bridge in this sandbox — mock both HTTP-calling functions and
    prove main() produces one merged report covering both dialects."""
    golden_file = tmp_path / "golden.jsonl"
    golden_file.write_text(
        json.dumps({"id": 1, "cat": "sva", "input": "She go home.", "golden": "She goes home."})
        + "\n"
    )
    clean_file = tmp_path / "clean.jsonl"
    clean_file.write_text(json.dumps({"id": "g001", "register": "golden", "text": "fine."}) + "\n")

    def fake_correct(bridge_url, text, source="x"):
        if "8000" in bridge_url:  # american: fixes it
            idx = text.index("go")
            return {"suggestions": [{"span": {"start": idx, "end": idx + 2}, "replacement": "goes"}]}
        return {"suggestions": []}  # british: leaves it (simulated miss)

    def fake_clean_run(bridge_url, corpus_file):
        return [{"id": "g001", "register": "golden", "flagged": False, "models": [], "categories": []}]

    monkeypatch.setattr(dialect_matrix, "RESULTS_FILE", tmp_path / "out.json")
    rc = main(
        argv=["http://127.0.0.1:8000", "http://127.0.0.1:8001", str(golden_file), str(clean_file)],
        correct_fn=fake_correct,
        clean_runner=fake_clean_run,
    )
    assert rc == 0
    out = json.loads((tmp_path / "out.json").read_text())
    assert len(out["reports"]) == 2
    american = next(r for r in out["reports"] if r["dialect"] == "american")
    british = next(r for r in out["reports"] if r["dialect"] == "british")
    assert american["golden"]["pass"] == 1
    assert british["golden"]["pass"] == 0
