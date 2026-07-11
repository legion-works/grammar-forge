"""Unit tests for run_eval.py's pure (no-bridge) per-case recording helper.

Importing run_eval executes its module-level arg parsing / golden.jsonl load
(same pattern already exercised safely: `python -c "import run_eval"` is a
no-op besides reading golden.jsonl and computing path constants — no network
call happens until main() runs), so this is a plain import, no bridge needed.
"""

from run_eval import build_suggestion_detail


def test_build_suggestion_detail_records_confidence_and_correctness():
    case_input = "go to school"
    case_golden = "goes to school"
    # synthetic bridge /correct response suggestions
    response_suggestions = [
        {
            "span": {"start": 0, "end": 2},
            "replacement": "goes",
            "model": "gector",
            "category": "sva",
            "confidence": 0.87,
        }
    ]
    suggestions, golden_spans = build_suggestion_detail(
        case_input, case_golden, response_suggestions
    )
    assert suggestions == [
        {
            "model": "gector",
            "category": "sva",
            "confidence": 0.87,
            "correct": True,
        }
    ]
    assert golden_spans == [{"start": 2, "end": 2, "replacement": "es"}]


def test_build_suggestion_detail_missing_category_defaults_to_empty_string():
    response_suggestions = [
        {
            "span": {"start": 0, "end": 2},
            "replacement": "goes",
            "model": "llm",
            "confidence": 0.5,
            # no "category" key -> grammar suggestion
        }
    ]
    suggestions, _ = build_suggestion_detail(
        "go to school", "goes to school", response_suggestions
    )
    assert suggestions[0]["category"] == ""


def test_build_suggestion_detail_marks_incorrect_edit():
    response_suggestions = [
        {
            "span": {"start": 0, "end": 2},
            "replacement": "went",
            "model": "llm",
            "category": "sva",
            "confidence": 0.9,
        }
    ]
    suggestions, _ = build_suggestion_detail(
        "go to school", "goes to school", response_suggestions
    )
    assert suggestions[0]["correct"] is False


def test_build_suggestion_detail_empty_suggestions_list():
    suggestions, golden_spans = build_suggestion_detail("same", "same", [])
    assert suggestions == []
    assert golden_spans == []


def test_build_suggestion_detail_multiple_suggestions_preserve_order():
    response_suggestions = [
        {
            "span": {"start": 0, "end": 2},
            "replacement": "goes",
            "model": "gector",
            "category": "sva",
            "confidence": 0.9,
        },
        {
            "span": {"start": 0, "end": 2},
            "replacement": "went",
            "model": "llm",
            "category": "sva",
            "confidence": 0.4,
        },
    ]
    suggestions, _ = build_suggestion_detail(
        "go to school", "goes to school", response_suggestions
    )
    assert [s["model"] for s in suggestions] == ["gector", "llm"]
    assert [s["correct"] for s in suggestions] == [True, False]
