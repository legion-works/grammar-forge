import json
import sys

import jfleg_eval
from jfleg_eval import (
    _parse_args,
    bootstrap_ci,
    compute_gleu,
    gleu_from_stats,
    gleu_sentence_stats,
    load_cases,
)


def test_gleu_sentence_stats_identical_hyp_ref():
    # >= 4 tokens so order-4 n-grams have a non-zero denominator (GLEU is
    # order-4 by default; shorter sentences legitimately zero out and score 0,
    # per the canonical Napoles implementation this is a faithful port of).
    toks = "the cat sat on the mat".split()
    stats = gleu_sentence_stats(toks, toks, toks)
    assert stats[0] == len(toks)  # c
    assert stats[1] == len(toks)  # r
    # every numerator should equal its denominator (perfect match)
    for num, den in zip(stats[2::2], stats[3::2]):
        assert num == den


def test_gleu_from_stats_perfect_match_is_one():
    toks = "the cat sat on the mat".split()
    stats = gleu_sentence_stats(toks, toks, toks)
    assert round(gleu_from_stats(stats), 6) == 1.0


def test_gleu_from_stats_zero_denominator_is_zero():
    assert gleu_from_stats([0, 0, 0, 0]) == 0.0


def test_compute_gleu_single_reference_perfect_hyp():
    # single ref per sentence -> iters collapses to 1, deterministic.
    # Sentences need >= 4 tokens for order-4 GLEU to be non-degenerate.
    s1 = "the quick brown fox jumps".split()
    s2 = "she walked to the store today".split()
    items = [(s1, s1, [s1]), (s2, s2, [s2])]
    mean, std, per_iter = compute_gleu(items)
    assert round(mean, 4) == 1.0
    assert std == 0.0
    assert len(per_iter) == 1


def test_compute_gleu_empty_items():
    mean, std, per_iter = compute_gleu([])
    assert mean == 0.0
    assert std == 0.0
    assert per_iter == []


def test_compute_gleu_lower_when_hyp_diverges_from_all_refs():
    ref = "the quick brown fox jumps".split()
    good = [(ref, ref, [ref])]
    bad = [(ref, "totally different words here now".split(), [ref])]
    g_mean, _, _ = compute_gleu(good)
    b_mean, _, _ = compute_gleu(bad)
    assert g_mean > b_mean


def test_bootstrap_ci_perfect_hyp_is_tight_around_one():
    ref = "the quick brown fox jumps".split()
    items = [(ref, ref, [ref])] * 20
    lo, hi, scores = bootstrap_ci(items, n_boot=50)
    assert len(scores) == 50
    assert round(lo, 4) == 1.0
    assert round(hi, 4) == 1.0


def test_bootstrap_ci_empty_items():
    lo, hi, scores = bootstrap_ci([])
    assert lo == 0.0 and hi == 0.0 and scores == []


def test_bootstrap_ci_bounds_ordering():
    import random as _random

    items = []
    rng = _random.Random(7)
    for i in range(10):
        src = [f"w{i}"]
        hyp = src if rng.random() > 0.3 else ["different"]
        items.append((src, hyp, [src]))
    lo, hi, _ = bootstrap_ci(items, n_boot=100)
    assert lo <= hi


def test_parse_args_defaults():
    bridge, limit, runs, out = _parse_args([])
    assert bridge == "http://127.0.0.1:8000"
    assert limit is None
    assert runs == 1
    assert out is None


def test_parse_args_with_runs_and_out():
    bridge, limit, runs, out = _parse_args(
        ["http://x:8000", "50", "--runs", "3", "--out", "/tmp/x.json"]
    )
    assert bridge == "http://x:8000"
    assert limit == 50
    assert runs == 3
    assert out == "/tmp/x.json"


def test_load_cases_respects_limit(tmp_path):
    p = tmp_path / "cases.jsonl"
    p.write_text(
        "\n".join(
            json.dumps({"id": i, "input": f"s{i}", "refs": [f"s{i}"]})
            for i in range(5)
        )
        + "\n"
    )
    cases = load_cases(path=p, limit=2)
    assert len(cases) == 2
    assert cases[0]["id"] == 0


def test_main_persists_results_and_runs_flag(tmp_path, monkeypatch):
    """Mocks collect_items (no live bridge in this environment) to prove
    main() wires --runs through to persisted aggregate stats."""
    cases_file = tmp_path / "jfleg_dev.jsonl"
    cases_file.write_text(
        json.dumps({"id": 0, "input": "a b", "refs": ["a b"]}) + "\n"
    )
    monkeypatch.setattr(jfleg_eval, "HERE", tmp_path)

    def fake_collect_items(cases):
        ref = "the quick brown fox jumps".split()
        return (
            [(ref, ref, [ref])],
            1,
            [0.01, 0.02],
            0,
        )

    monkeypatch.setattr(jfleg_eval, "collect_items", fake_collect_items)
    out_file = tmp_path / "out.json"
    monkeypatch.setattr(
        sys, "argv", ["jfleg_eval.py", "http://x", "--runs", "2", "--out", str(out_file)]
    )
    rc = jfleg_eval.main()
    assert rc == 0
    out = json.loads(out_file.read_text())
    assert out["n_runs"] == 2
    assert len(out["runs"]) == 2
    assert out["aggregate"]["n_runs"] == 2
    assert round(out["runs"][0]["gleu_mean"], 4) == 1.0
