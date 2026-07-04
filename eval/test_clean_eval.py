from clean_eval import score_clean_results


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
