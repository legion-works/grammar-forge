import json

from overedit_rule_study import (
    RULE_IDS,
    decide_threshold,
    group_fired_golden,
    group_positives,
    load_fired,
    load_fixtures,
    load_probe_scores,
    main,
    run_study,
)

# ---- decide_threshold: the three verdict shapes -----------------------------


def test_decide_threshold_not_needed_when_zero_fired_golden():
    result = decide_threshold(positives=[0.9, 0.95, 1.0], fired_golden=[])
    assert result == {
        "verdict": "not_needed",
        "threshold": None,
        "margin": None,
        "positives": 3,
        "fired_golden": 0,
    }


def test_decide_threshold_usable_low_tail_exclusion():
    # Pinned tail-shape (a) from the plan: G = 0.80 (single fired-golden pair),
    # 8 positives at 0.90 (eligible: 0.90-0.80=0.10 >= 0.05), 2 positives at
    # 0.81 = G+0.01 (NOT eligible: 0.01 < 0.05). eligible=8 >= ceil(0.7*10)=7
    # -> usable. t_R = min(eligible) = 0.90; both low-tail positives at 0.81
    # sit OUTSIDE the gate (0.81 < 0.90).
    positives = [0.90] * 8 + [0.81] * 2
    fired_golden = [0.80]
    result = decide_threshold(positives, fired_golden)
    assert result["verdict"] == "usable"
    assert result["threshold"] == 0.90
    assert result["margin"] == round(0.90 - 0.80, 6)
    assert result["positives"] == 10
    assert result["fired_golden"] == 1
    # The gate ("keep p >= threshold") must exclude both low-tail positives.
    assert all(p < result["threshold"] for p in positives if p == 0.81)


def test_decide_threshold_usable_interval_bug_regression():
    # Pinned tail-shape (b) from the plan: G = 0.80, seven positives at 0.85
    # (eligible: 0.85-0.80=0.05 exactly, inclusive), three at 0.83 (NOT
    # eligible: 0.03 < 0.05). eligible=7 >= ceil(0.7*10)=7 -> usable via the
    # SEVEN, not the whole ten. t_R = min(eligible) = 0.85. A buggy midpoint
    # threshold between the tails would have admitted the 0.83 scores at a
    # smaller margin; t_R = min(eligible) must NOT do that.
    positives = [0.85] * 7 + [0.83] * 3
    fired_golden = [0.80]
    result = decide_threshold(positives, fired_golden)
    assert result["verdict"] == "usable"
    assert result["threshold"] == 0.85
    assert result["margin"] == 0.05
    # The three 0.83 positives must NOT be kept by the deployed gate (p >= t_R).
    assert not any(p >= result["threshold"] for p in positives if p == 0.83)


def test_decide_threshold_refuted_when_no_eligible_threshold():
    # G = 0.80; every positive sits within the 0.05 margin of G (all
    # ineligible) -> eligible=0 < ceil(0.7*4)=3 -> refuted.
    positives = [0.81, 0.82, 0.83, 0.84]
    fired_golden = [0.80]
    result = decide_threshold(positives, fired_golden)
    assert result == {
        "verdict": "refuted",
        "threshold": None,
        "margin": None,
        "positives": 4,
        "fired_golden": 1,
    }


def test_decide_threshold_margin_boundary_is_inclusive():
    # A single positive at EXACTLY G + 0.05 must count as eligible (the
    # spec's inclusive >= 0.05 comparison, after 6-decimal rounding).
    positives = [0.85]
    fired_golden = [0.80]
    result = decide_threshold(positives, fired_golden)
    assert result["verdict"] == "usable"
    assert result["threshold"] == 0.85
    assert result["margin"] == 0.05


def test_decide_threshold_margin_boundary_float_noise_still_rounds_to_inclusive():
    # 0.85 - 0.80 in raw double arithmetic is 0.04999999999999993 (float
    # noise) -- the round-to-6-decimals step must still treat it as exactly
    # the boundary and include it.
    positives = [0.85]
    fired_golden = [0.80]
    result = decide_threshold(positives, fired_golden)
    assert round(0.85 - 0.80, 6) == 0.05
    assert result["verdict"] == "usable"


# ---- grouping: unknown-rule exclusion ---------------------------------------


def test_group_positives_excludes_unknown_and_counts_them():
    fixtures = [
        {"original": "a", "overedited": "b", "rule": "singular_they"},
        {"original": "c", "overedited": "d", "rule": "unknown"},
        {"original": "e", "overedited": "f", "rule": "singular_they"},
        {"original": "g", "overedited": "h", "rule": "unknown"},
    ]
    probe = {"f0": 0.9, "f1": 0.5, "f2": 0.95, "f3": 0.6}
    positives, n_unknown = group_positives(fixtures, probe)
    assert n_unknown == 2
    assert positives["singular_they"] == [0.9, 0.95]
    # every other rule id present with an empty list
    for rule_id in RULE_IDS:
        if rule_id != "singular_they":
            assert positives[rule_id] == []


def test_group_positives_rejects_unrecognized_rule_id():
    fixtures = [{"original": "a", "overedited": "b", "rule": "not_a_real_rule"}]
    probe = {"f0": 0.9}
    try:
        group_positives(fixtures, probe)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


def test_group_fired_golden_groups_by_rule():
    fired = [
        ("12", "singular_they"),
        ("40", "singular_they"),
        ("91", "modal_perfect_addition"),
    ]
    probe = {"g12": 0.9, "g40": 0.95, "g91": 0.7}
    grouped = group_fired_golden(fired, probe)
    assert grouped["singular_they"] == [0.9, 0.95]
    assert grouped["modal_perfect_addition"] == [0.7]
    assert grouped["proximity_agreement_flip"] == []


# ---- file loaders -------------------------------------------------------


def test_load_probe_scores_rounds_to_six_decimals(tmp_path):
    p = tmp_path / "probe.tsv"
    p.write_text("f0\t0.1234565\ng12\t0.999999949\n")
    scores = load_probe_scores(p)
    assert scores["f0"] == round(0.1234565, 6)
    assert scores["g12"] == round(0.999999949, 6)


def test_load_fixtures_preserves_order(tmp_path):
    p = tmp_path / "fixtures.jsonl"
    p.write_text(
        '{"original": "a", "overedited": "b", "rule": "singular_they"}\n'
        '{"original": "c", "overedited": "d", "rule": "modal_perfect_addition"}\n'
    )
    fixtures = load_fixtures(p)
    assert [f["rule"] for f in fixtures] == ["singular_they", "modal_perfect_addition"]


def test_load_fired_parses_tab_separated_pairs(tmp_path):
    p = tmp_path / "fired.tsv"
    p.write_text("12\tsingular_they\n91\tmodal_perfect_addition\n")
    fired = load_fired(p)
    assert fired == [("12", "singular_they"), ("91", "modal_perfect_addition")]


# ---- end-to-end: run_study / main -------------------------------------------


def _write_synthetic_corpus(tmp_path):
    """Builds a small synthetic (probe, fixtures, fired) triple that produces
    all three verdicts across three different rules in one run:
      - singular_they: usable (low-tail exclusion shape)
      - modal_perfect_addition: not_needed (zero fired-golden)
      - contraction_expansion: refuted (no eligible threshold)
    The other three rules get zero positives/zero fired -> not_needed.
    """
    fixtures_path = tmp_path / "fixtures.jsonl"
    fixture_rows = (
        [
            {"original": f"o{i}", "overedited": f"c{i}", "rule": "singular_they"}
            for i in range(8)
        ]
        + [
            {"original": f"o{i}", "overedited": f"c{i}", "rule": "singular_they"}
            for i in range(8, 10)
        ]
        + [
            {
                "original": f"o{i}",
                "overedited": f"c{i}",
                "rule": "contraction_expansion",
            }
            for i in range(10, 14)
        ]
        + [{"original": "ox", "overedited": "cx", "rule": "unknown"}]
    )
    fixtures_path.write_text("\n".join(json.dumps(r) for r in fixture_rows) + "\n")

    probe_path = tmp_path / "probe.tsv"
    probe_lines = []
    # singular_they positives: f0..f7 at 0.90 (eligible), f8,f9 at 0.81 (low-tail)
    for i in range(8):
        probe_lines.append(f"f{i}\t0.900000")
    for i in range(8, 10):
        probe_lines.append(f"f{i}\t0.810000")
    # contraction_expansion positives: f10..f13 all within margin of G (refuted)
    for i in range(10, 14):
        probe_lines.append(f"f{i}\t0.820000")
    probe_lines.append("f14\t0.500000")  # the unknown-tagged fixture
    # fired-golden pairs
    probe_lines.append("g1\t0.800000")  # singular_they's G
    probe_lines.append("g2\t0.800000")  # contraction_expansion's G
    probe_path.write_text("\n".join(probe_lines) + "\n")

    fired_path = tmp_path / "fired.tsv"
    fired_path.write_text("1\tsingular_they\n2\tcontraction_expansion\n")

    return probe_path, fixtures_path, fired_path


def test_run_study_produces_all_three_verdict_shapes_and_excludes_unknown():
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as d:
        probe_path, fixtures_path, fired_path = _write_synthetic_corpus(Path(d))
        rules, n_unknown = run_study(probe_path, fixtures_path, fired_path)

    assert n_unknown == 1
    assert set(rules.keys()) == set(RULE_IDS)

    assert rules["singular_they"]["verdict"] == "usable"
    assert rules["singular_they"]["threshold"] == 0.90
    assert rules["singular_they"]["positives"] == 10

    assert rules["contraction_expansion"]["verdict"] == "refuted"
    assert rules["contraction_expansion"]["threshold"] is None

    assert rules["modal_perfect_addition"]["verdict"] == "not_needed"
    assert rules["modal_perfect_addition"]["fired_golden"] == 0
    assert rules["modal_perfect_addition"]["positives"] == 0


def test_main_end_to_end_writes_json_and_prints_table(tmp_path, capsys):
    probe_path, fixtures_path, fired_path = _write_synthetic_corpus(tmp_path)
    out_path = tmp_path / "out.json"

    rc = main(
        [
            str(probe_path),
            str(fixtures_path),
            str(fired_path),
            "-o",
            str(out_path),
        ]
    )
    assert rc == 0

    captured = capsys.readouterr()
    assert "singular_they" in captured.out
    assert "usable" in captured.out
    assert "unknown_fixtures" in captured.out

    written = json.loads(out_path.read_text())
    assert written["probe"] == "semverify-probe"
    assert "generated" in written
    assert written["unknown_fixtures"] == 1
    assert set(written["rules"].keys()) == set(RULE_IDS)
    assert written["rules"]["singular_they"]["verdict"] == "usable"
    assert written["rules"]["singular_they"]["threshold"] == 0.90
