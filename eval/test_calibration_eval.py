import json

from calibration_eval import (
    build_edit_reliability_table,
    build_model_category_table,
    build_reliability_table,
    bucket_index,
    expected_calibration_error,
    extract_all_suggestions,
    main,
)


def test_bucket_index_basic():
    assert bucket_index(0) == 0
    assert bucket_index(9) == 0
    assert bucket_index(10) == 1
    assert bucket_index(95) == 9
    assert bucket_index(100) == 9  # closed top bucket, not an 11th bucket


def _row(score, passed):
    return {"score": score, "pass": passed}


# ---- per-case mode (--per-case, legacy behavior) --------------------------


def test_build_reliability_table_perfect_calibration():
    # every row's score/100 matches the bucket's empirical accuracy exactly
    rows = [_row(95, True), _row(95, True), _row(95, False)]  # 2/3 pass, conf .95
    table = build_reliability_table(rows)
    bucket_90 = next(b for b in table if b["lo"] == 90)
    assert bucket_90["n"] == 3
    assert bucket_90["mean_confidence"] == 0.95
    assert round(bucket_90["empirical_accuracy"], 4) == round(2 / 3, 4)
    assert bucket_90["gap"] > 0  # 0.95 confidence vs 0.667 accuracy: miscalibrated


def test_build_reliability_table_skips_rows_without_score_or_pass():
    rows = [_row(90, True), {"score": None, "pass": True}, {"score": 80}]
    table = build_reliability_table(rows)
    n_total = sum(b["n"] for b in table)
    assert n_total == 1


def test_expected_calibration_error_zero_when_perfectly_calibrated():
    # all scores 100, all pass -> confidence 1.0, accuracy 1.0, gap 0
    rows = [_row(100, True) for _ in range(10)]
    table = build_reliability_table(rows)
    assert expected_calibration_error(table) == 0.0


def test_expected_calibration_error_positive_when_overconfident():
    # high score (95) but only half pass -> systematic overconfidence
    rows = [_row(95, True), _row(95, False)] * 5
    table = build_reliability_table(rows)
    ece = expected_calibration_error(table)
    assert ece > 0.3  # confidence .95 vs accuracy .5 -> gap ~.45


def test_expected_calibration_error_empty_table_is_zero():
    assert expected_calibration_error([]) == 0.0
    assert expected_calibration_error(build_reliability_table([])) == 0.0


def test_main_per_case_flag_runs_against_legacy_shaped_results_json(
    tmp_path, monkeypatch, capsys
):
    """End-to-end smoke test with a synthetic OLD-shape results.json
    (id/cat/.../score/pass, no `suggestions` field) via --per-case, which
    reproduces the exact pre-Task-4 behavior."""
    results = tmp_path / "results.json"
    rows = [{"id": i, "cat": "sva", "score": 90, "pass": i % 2 == 0} for i in range(10)]
    results.write_text(json.dumps(rows))
    out_file = tmp_path / "calibration_results.json"
    import calibration_eval

    monkeypatch.setattr(calibration_eval, "DEFAULT_OUT", out_file)
    monkeypatch.setattr("sys.argv", ["calibration_eval.py", str(results), "--per-case"])
    rc = main()
    assert rc == 0
    out = json.loads(out_file.read_text())
    assert out["mode"] == "per-case"
    assert out["n_rows_total"] == 10
    assert out["n_rows_scored"] == 10
    assert 0.0 <= out["ece"] <= 1.0
    captured = capsys.readouterr()
    assert "ECE" in captured.out


# ---- per-edit mode (default, Task 4) ---------------------------------


def _sugg(model, category, confidence, correct):
    return {
        "model": model,
        "category": category,
        "confidence": confidence,
        "correct": correct,
    }


def _row_with_suggestions(row_id, suggestions):
    return {"id": row_id, "cat": "sva", "suggestions": suggestions}


def test_extract_all_suggestions_flattens_across_cases():
    rows = [
        _row_with_suggestions(1, [_sugg("gector", "sva", 0.9, True)]),
        _row_with_suggestions(
            2,
            [
                _sugg("gector", "sva", 0.8, False),
                _sugg("llm", "", 0.5, True),
            ],
        ),
    ]
    suggestions, n_skipped = extract_all_suggestions(rows)
    assert len(suggestions) == 3
    assert n_skipped == 0


def test_extract_all_suggestions_skips_rows_missing_field_gracefully():
    """Old results.json (pre-Task-4) rows have no `suggestions` key at all —
    must be skipped, not error, and the count reported."""
    rows = [
        _row_with_suggestions(1, [_sugg("gector", "sva", 0.9, True)]),
        {"id": 2, "cat": "sva", "score": 80, "pass": True},  # old-shape row
    ]
    suggestions, n_skipped = extract_all_suggestions(rows)
    assert len(suggestions) == 1
    assert n_skipped == 1


def test_build_edit_reliability_table_perfect_calibration():
    suggestions = [
        _sugg("gector", "sva", 0.95, True),
        _sugg("gector", "sva", 0.95, True),
        _sugg("gector", "sva", 0.95, False),
    ]
    table = build_edit_reliability_table(suggestions)
    bucket_90 = next(b for b in table if b["lo"] == 90)
    assert bucket_90["n"] == 3
    assert bucket_90["mean_confidence"] == 0.95
    assert round(bucket_90["empirical_accuracy"], 4) == round(2 / 3, 4)
    assert bucket_90["gap"] > 0


def test_build_edit_reliability_table_skips_missing_confidence_or_correct():
    suggestions = [
        _sugg("gector", "sva", 0.9, True),
        {"model": "gector", "category": "sva", "confidence": None, "correct": True},
        {"model": "gector", "category": "sva", "confidence": 0.5},  # no "correct"
    ]
    table = build_edit_reliability_table(suggestions)
    n_total = sum(b["n"] for b in table)
    assert n_total == 1


def test_build_model_category_table_groups_and_reports_gap():
    suggestions = [
        _sugg("gector", "sva", 0.9, True),
        _sugg("gector", "sva", 0.9, False),
        _sugg("llm", "", 0.6, True),
    ]
    table = build_model_category_table(suggestions)
    assert {(row["model"], row["category"]) for row in table} == {
        ("gector", "sva"),
        ("llm", ""),
    }
    gector_row = next(r for r in table if r["model"] == "gector")
    assert gector_row["n"] == 2
    assert gector_row["mean_confidence"] == 0.9
    assert gector_row["empirical_accuracy"] == 0.5
    assert gector_row["gap"] == 0.4


def test_expected_calibration_error_works_on_edit_table_too():
    # ECE is computed generically from any n/gap table — same function
    # serves both modes.
    suggestions = [_sugg("m", "c", 1.0, True) for _ in range(5)]
    table = build_edit_reliability_table(suggestions)
    assert expected_calibration_error(table) == 0.0


def test_main_default_per_edit_mode_runs_against_suggestions_shaped_results(
    tmp_path, monkeypatch, capsys
):
    """End-to-end smoke test with a synthetic Task-4-shape results.json
    (each row carries a `suggestions` list) via the new DEFAULT mode."""
    results = tmp_path / "results.json"
    rows = [
        _row_with_suggestions(
            i,
            [
                _sugg("gector", "sva", 0.9, i % 2 == 0),
                _sugg("llm", "punct", 0.4, i % 3 == 0),
            ],
        )
        for i in range(10)
    ]
    results.write_text(json.dumps(rows))
    out_file = tmp_path / "calibration_results.json"
    import calibration_eval

    monkeypatch.setattr(calibration_eval, "DEFAULT_OUT", out_file)
    monkeypatch.setattr("sys.argv", ["calibration_eval.py", str(results)])
    rc = main()
    assert rc == 0
    out = json.loads(out_file.read_text())
    assert out["mode"] == "per-edit"
    assert out["n_rows_total"] == 10
    assert out["n_rows_skipped_missing_suggestions"] == 0
    assert out["n_suggestions_total"] == 20
    assert out["n_suggestions_scored"] == 20
    assert 0.0 <= out["ece"] <= 1.0
    assert {(r["model"], r["category"]) for r in out["model_category_table"]} == {
        ("gector", "sva"),
        ("llm", "punct"),
    }
    captured = capsys.readouterr()
    assert "ECE" in captured.out
    assert "Per-edit reliability table" in captured.out
    assert "Per-(model,category) reliability" in captured.out


def test_main_default_mode_skips_old_shape_rows_gracefully(
    tmp_path, monkeypatch, capsys
):
    """A results.json written by the OLD run_eval.py (no `suggestions`
    field) must not crash the default mode — rows are skipped and the
    skip count reported."""
    results = tmp_path / "results.json"
    rows = [{"id": i, "cat": "sva", "score": 90, "pass": True} for i in range(4)]
    results.write_text(json.dumps(rows))
    out_file = tmp_path / "calibration_results.json"
    import calibration_eval

    monkeypatch.setattr(calibration_eval, "DEFAULT_OUT", out_file)
    monkeypatch.setattr("sys.argv", ["calibration_eval.py", str(results)])
    rc = main()
    assert rc == 0
    out = json.loads(out_file.read_text())
    assert out["mode"] == "per-edit"
    assert out["n_rows_total"] == 4
    assert out["n_rows_skipped_missing_suggestions"] == 4
    assert out["n_suggestions_total"] == 0
    assert out["ece"] == 0.0
    captured = capsys.readouterr()
    assert "skipped" in captured.out
