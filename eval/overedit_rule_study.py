#!/usr/bin/env python3
"""Per-rule fired-pair-conditioned over-edit threshold study (Task 10).

Offline, decisive-either-way follow-up to the §5 GLOBAL semantic-verifier
study (`verifier_calibration.py` / `verifier_equivalence_check.py`), which
was REFUTED: a single universal cosine threshold cannot separate over-edits
from legitimate golden corrections (min golden cosine 0.5664 < max over-edit
cosine 1.0000). This script studies the SAME cosine signal PER RULE, and
ONLY over pairs the rule actually fires on ("fired-pair-conditioned"):

  - Positives: the 34 `overedit_fixtures.jsonl` pairs (original, overedited),
    each tagged with the rule class it exercises, scored by
    `semverify-probe` (`f<index>` rows in the probe TSV).
  - Negatives: golden `(input, golden)` pairs the rule ALSO fires on per
    `overedit-fired` (`bridge/cmd/overedit-fired`) — cases where reverting
    would have mangled a legitimate correction — scored by the same probe
    (`g<id>` rows).

Gate semantics: "revert only when cos(original, corrected) >= t_R" — an
over-edit is meaning-PRESERVING (high cosine to the original), a genuine
rewrite is meaning-CHANGING (low cosine), so the gate must sit strictly
ABOVE every fired-golden cosine with a safety margin, while keeping enough
of the rule's own positives to still be useful.

Decision rule per rule R, computed over FIRED pairs only (see decide_threshold
docstring for the exact determinism contract — 6-decimal rounding, ceil(0.70
* n) eligibility floor, t_R = min(eligible), never a midpoint).

Usage:
    python3 overedit_rule_study.py [probe_scores.tsv] [fixtures.jsonl] [fired.tsv] [-o out.json]

Defaults point at the sibling eval/ artifacts:
    semverify_probe_scores.tsv, overedit_fixtures.jsonl, overedit_fired.tsv
    -> overedit_rule_thresholds.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).parent
DEFAULT_PROBE = HERE / "semverify_probe_scores.tsv"
DEFAULT_FIXTURES = HERE / "overedit_fixtures.jsonl"
DEFAULT_FIRED = HERE / "overedit_fired.tsv"
DEFAULT_OUT = HERE / "overedit_rule_thresholds.json"

# The six measured over-edit classes, in DefaultNamedOverEditRules() registry
# order (bridge/internal/correction/overedit.go). The dialect rule
# (DialectSpellingRevertRuleID) is lexicon-driven, not part of this study.
RULE_IDS = [
    "proximity_agreement_flip",
    "proper_noun_comma_restructure",
    "mid_word_case_flip",
    "contraction_expansion",
    "singular_they",
    "modal_perfect_addition",
]

MARGIN_FLOOR = 0.05
ELIGIBLE_FRACTION_NUM = 7  # ELIGIBLE_FRACTION = 7/10 = 0.70, kept as an exact
ELIGIBLE_FRACTION_DEN = 10  # fraction so the usability floor never touches float math.


def load_probe_scores(path: Path) -> dict[str, float]:
    """Parses semverify-probe's `id<TAB>cosine` TSV (fixtures = `f<index>`,
    golden = `g<id>`) into one dict, rounding every score to 6 decimals —
    the study's determinism contract applies from the moment scores are
    read, not just at threshold-selection time."""
    scores: dict[str, float] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        pid, cos = line.split("\t")
        scores[pid] = round(float(cos), 6)
    return scores


def load_fixtures(path: Path) -> list[dict]:
    """Reads overedit_fixtures.jsonl. List order IS the `f<index>` probe id
    (index = 0-based line number), so callers must not reorder/filter this
    list before indexing into it."""
    fixtures = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        fixtures.append(json.loads(line))
    return fixtures


def load_fired(path: Path) -> list[tuple[str, str]]:
    """Reads overedit-fired's `caseID<TAB>ruleID` TSV -> [(caseID, ruleID), ...]."""
    fired = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        case_id, rule_id = line.split("\t")
        fired.append((case_id, rule_id))
    return fired


def group_positives(
    fixtures: list[dict], probe: dict[str, float]
) -> tuple[dict[str, list[float]], int]:
    """Groups fixture cosines by tagged rule (positives_by_rule[rule] = list
    of f<index> cosines). Fixtures tagged "unknown" are excluded from
    grouping; their count is returned separately (n_unknown)."""
    positives: dict[str, list[float]] = {rule_id: [] for rule_id in RULE_IDS}
    n_unknown = 0
    for idx, fixture in enumerate(fixtures):
        rule = fixture.get("rule")
        if rule == "unknown":
            n_unknown += 1
            continue
        if rule not in positives:
            raise ValueError(f"fixture index {idx} has unrecognized rule {rule!r}")
        positives[rule].append(probe[f"f{idx}"])
    return positives, n_unknown


def group_fired_golden(
    fired: list[tuple[str, str]], probe: dict[str, float]
) -> dict[str, list[float]]:
    """Groups fired-golden cosines by rule ID from the overedit-fired TSV."""
    fired_golden: dict[str, list[float]] = {rule_id: [] for rule_id in RULE_IDS}
    for case_id, rule_id in fired:
        if rule_id not in fired_golden:
            raise ValueError(f"fired.tsv has unrecognized rule {rule_id!r}")
        fired_golden[rule_id].append(probe[f"g{case_id}"])
    return fired_golden


def _eligible_floor(n_positives: int) -> int:
    """ceil(0.70 * n_positives), computed with exact integer arithmetic
    (ceil(a/b) == (a*num + den - 1) // den) so the usability floor never
    depends on float rounding of 0.7 * n."""
    numerator = n_positives * ELIGIBLE_FRACTION_NUM
    return (numerator + ELIGIBLE_FRACTION_DEN - 1) // ELIGIBLE_FRACTION_DEN


def decide_threshold(positives: list[float], fired_golden: list[float]) -> dict:
    """Per-rule verdict over FIRED pairs only. All scores are assumed
    pre-rounded to 6 decimals (load_probe_scores does this).

    - Zero fired-golden pairs -> verdict "not_needed": the rule's safety
      DISCRIMINATOR already never fires on a legitimate golden correction,
      so the pattern alone is precise and no cosine gate is needed
      (threshold/margin null).
    - Otherwise: G = max(fired-golden cosine). eligible = positives p with
      round(p - G, 6) >= 0.05 (inclusive). usable iff
      len(eligible) >= ceil(0.70 * len(positives)).
      - usable -> verdict "usable", threshold t_R = min(eligible) (== the
        SMALLEST eligible positive, NOT a midpoint: the deployed gate keeps
        every positive p >= t_R, so a threshold below min(eligible) would
        admit an ineligible low-tail positive sitting in (t_R, min(eligible))
        and silently violate the 0.05 margin invariant). margin = t_R - G.
      - not usable -> verdict "refuted" (threshold/margin null).
    """
    n_positives = len(positives)
    n_fired = len(fired_golden)

    if n_fired == 0:
        return {
            "verdict": "not_needed",
            "threshold": None,
            "margin": None,
            "positives": n_positives,
            "fired_golden": n_fired,
        }

    g = max(fired_golden)
    eligible = [p for p in positives if round(p - g, 6) >= MARGIN_FLOOR]
    required = _eligible_floor(n_positives)

    if len(eligible) < required:
        return {
            "verdict": "refuted",
            "threshold": None,
            "margin": None,
            "positives": n_positives,
            "fired_golden": n_fired,
        }

    threshold = round(min(eligible), 6)
    margin = round(threshold - g, 6)
    return {
        "verdict": "usable",
        "threshold": threshold,
        "margin": margin,
        "positives": n_positives,
        "fired_golden": n_fired,
    }


def run_study(
    probe_path: Path, fixtures_path: Path, fired_path: Path
) -> tuple[dict[str, dict], int]:
    """Loads the three input files and returns (rules, n_unknown_fixtures)."""
    probe = load_probe_scores(probe_path)
    fixtures = load_fixtures(fixtures_path)
    fired = load_fired(fired_path)

    positives_by_rule, n_unknown = group_positives(fixtures, probe)
    fired_golden_by_rule = group_fired_golden(fired, probe)

    rules = {
        rule_id: decide_threshold(
            positives_by_rule[rule_id], fired_golden_by_rule[rule_id]
        )
        for rule_id in RULE_IDS
    }
    return rules, n_unknown


def format_table(rules: dict[str, dict]) -> str:
    header = (
        f"{'rule':<32s} {'verdict':<11s} {'threshold':>9s} {'margin':>8s} "
        f"{'positives':>9s} {'fired_golden':>12s}"
    )
    lines = [header, "-" * len(header)]
    for rule_id in RULE_IDS:
        r = rules[rule_id]
        thr = f"{r['threshold']:.6f}" if r["threshold"] is not None else "-"
        margin = f"{r['margin']:.6f}" if r["margin"] is not None else "-"
        lines.append(
            f"{rule_id:<32s} {r['verdict']:<11s} {thr:>9s} {margin:>8s} "
            f"{r['positives']:>9d} {r['fired_golden']:>12d}"
        )
    return "\n".join(lines)


def _parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "probe_scores",
        nargs="?",
        type=Path,
        default=DEFAULT_PROBE,
        help=f"semverify-probe TSV (default: {DEFAULT_PROBE.name})",
    )
    parser.add_argument(
        "fixtures",
        nargs="?",
        type=Path,
        default=DEFAULT_FIXTURES,
        help=f"tagged over-edit fixtures JSONL (default: {DEFAULT_FIXTURES.name})",
    )
    parser.add_argument(
        "fired",
        nargs="?",
        type=Path,
        default=DEFAULT_FIRED,
        help=f"overedit-fired TSV (default: {DEFAULT_FIRED.name})",
    )
    parser.add_argument(
        "-o",
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"output JSON path (default: {DEFAULT_OUT.name})",
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(argv)

    rules, n_unknown = run_study(args.probe_scores, args.fixtures, args.fired)

    out = {
        "generated": datetime.now(UTC).isoformat(),
        "probe": "semverify-probe",
        "rules": rules,
        "unknown_fixtures": n_unknown,
    }
    args.out.write_text(json.dumps(out, indent=2) + "\n")

    print(format_table(rules))
    print(f"\nunknown_fixtures (excluded from grouping): {n_unknown}")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
