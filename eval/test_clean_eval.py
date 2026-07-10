import sys

from clean_eval import aggregate_runs, score_clean_results


def _r(id_: str, register: str, flagged: bool, models=None, categories=None) -> dict:
    return {
        "id": id_,
        "register": register,
        "flagged": flagged,
        "models": models or [],
        "categories": categories or [],
    }


def test_score_counts_fp_rate_and_attribution() -> None:
    results = [
        _r("g001", "golden", False),
        _r("g002", "golden", True, models=["llm"], categories=["grammar"]),
        _r(
            "a001",
            "casual",
            True,
            models=["harper", "llm"],
            categories=["spelling", "grammar"],
        ),
        _r("a013", "technical", False),
    ]
    s = score_clean_results(results)
    assert s["total"] == 4
    assert s["false_positives"] == 2
    assert abs(s["fp_rate"] - 0.5) < 1e-9
    assert s["by_register"]["golden"] == {"total": 2, "fp": 1}
    assert s["by_register"]["casual"] == {"total": 1, "fp": 1}
    assert s["by_model"]["llm"] == 2
    assert s["by_model"]["harper"] == 1
    assert s["by_category"]["grammar"] == 2


def test_score_empty_corpus_is_zero_rate() -> None:
    s = score_clean_results([])
    assert s["total"] == 0
    assert s["fp_rate"] == 0.0


def test_error_row_does_not_count_as_fp() -> None:
    results = [
        _r("g001", "golden", False),
        {"id": "g002", "register": "golden", "flagged": False, "error": "timeout"},
    ]
    s = score_clean_results(results)
    assert s["total"] == 1  # error row excluded
    assert s["false_positives"] == 0
    assert s["fp_rate"] == 0.0


def test_aggregate_runs_reports_mean_stdev_min_max() -> None:
    # 3 runs of the same 4-case corpus with a stochastic 0/1/2 FP count each.
    run_summaries = [
        {"fp_rate": 0.0, "false_positives": 0, "total": 4},
        {"fp_rate": 0.25, "false_positives": 1, "total": 4},
        {"fp_rate": 0.5, "false_positives": 2, "total": 4},
    ]
    agg = aggregate_runs(run_summaries)
    assert agg["n_runs"] == 3
    assert agg["fp_rate"]["mean"] == 0.25
    assert agg["fp_rate"]["min"] == 0.0
    assert agg["fp_rate"]["max"] == 0.5
    assert agg["fp_rate"]["stdev"] > 0.0
    assert agg["false_positives"]["mean"] == 1.0


def test_aggregate_runs_single_run_has_zero_stdev() -> None:
    agg = aggregate_runs([{"fp_rate": 0.1, "false_positives": 1, "total": 10}])
    assert agg["n_runs"] == 1
    assert agg["fp_rate"]["stdev"] == 0.0
    assert agg["fp_rate"]["mean"] == 0.1


def test_run_and_runs_flag_end_to_end(tmp_path, monkeypatch) -> None:
    """Mocks the bridge call (no live bridge in this environment) to prove
    --runs N drives N full-corpus passes and persists all of them."""
    import json as _json

    import clean_eval

    corpus = tmp_path / "corpus.jsonl"
    corpus.write_text(
        _json.dumps({"id": "c1", "register": "golden", "text": "This is fine."})
        + "\n"
    )

    call_count = {"n": 0}

    def fake_run(bridge_url, corpus_file):
        call_count["n"] += 1
        # every OTHER run flags the sentence, simulating sampling variance
        flagged = call_count["n"] % 2 == 0
        return [
            {
                "id": "c1",
                "register": "golden",
                "flagged": flagged,
                "models": ["llm"] if flagged else [],
                "categories": ["grammar"] if flagged else [],
                "text": "This is fine.",
                "suggestions": [],
                "latency_ms": 5.0,
            }
        ]

    monkeypatch.setattr(clean_eval, "run", fake_run)
    monkeypatch.setattr(
        sys, "argv", ["clean_eval.py", "http://x", str(corpus), "--runs", "4", "--out", str(tmp_path / "out.json")]
    )
    rc = clean_eval.main()
    assert call_count["n"] == 4
    out = _json.loads((tmp_path / "out.json").read_text())
    assert out["n_runs"] == 4
    assert len(out["runs"]) == 4
    assert out["aggregate"]["fp_rate"]["mean"] == 0.5  # 2 of 4 runs flagged
    assert rc == 0  # default --max-fp-rate is report-only (100)
