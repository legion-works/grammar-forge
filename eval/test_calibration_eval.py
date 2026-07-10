import json

from calibration_eval import (
    bucket_index,
    build_reliability_table,
    expected_calibration_error,
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


def test_main_runs_against_real_results_json(tmp_path, monkeypatch, capsys):
    """End-to-end smoke test with a synthetic results.json (mirrors
    run_eval.py's actual row shape: id/cat/.../score/pass)."""
    results = tmp_path / "results.json"
    rows = [
        {"id": i, "cat": "sva", "score": 90, "pass": i % 2 == 0} for i in range(10)
    ]
    results.write_text(json.dumps(rows))
    out_file = tmp_path / "calibration_results.json"
    import calibration_eval

    monkeypatch.setattr(calibration_eval, "DEFAULT_OUT", out_file)
    monkeypatch.setattr("sys.argv", ["calibration_eval.py", str(results)])
    rc = main()
    assert rc == 0
    out = json.loads(out_file.read_text())
    assert out["n_rows_total"] == 10
    assert out["n_rows_scored"] == 10
    assert 0.0 <= out["ece"] <= 1.0
    captured = capsys.readouterr()
    assert "ECE" in captured.out
