#!/usr/bin/env bash
# Turnkey re-run: golden -> clean -> conll14 -> bea19 -> jfleg -> calibration,
# in the documented cold-restart order (see README.md "Determinism: the
# COLD-RESTART protocol"), persisting every artifact with a timestamp + bridge
# commit hash, and printing one summary table at the end.
#
# Usage:
#   eval/run_all.sh [bridge_url]
#     bridge_url        default http://127.0.0.1:8000
#
# Env vars:
#   GF_SKIP_RESTART=1   skip the `docker compose restart llamacpp` step (use
#                       when the caller already cold-restarted, or the bridge
#                       isn't a local docker-compose deployment)
#   GF_COMPOSE_DIR      directory to run `docker compose restart` from
#                       (default: repo root, one level up from eval/)
#   GF_SKIP_BENCHMARKS=1  skip conll14/bea19 (their gitignored corpora are
#                       often not fetched in a quick smoke run)
#   GF_GATE=1           exit nonzero if ANY step's gate is "fail" or "error"
#                       ("skipped" alone never fails — skips are declared,
#                       errors are not). Default: report-only, exit 0.
#
# Every step is best-effort: a missing corpus (conll14/bea19/jfleg data is
# gitignored, jfleg needs a manual fetch, get_benchmarks.sh needs a one-time
# run) is REPORTED, not fatal — the run continues and the summary marks that
# step SKIPPED. A step's own failure (bridge unreachable, non-zero exit) is
# recorded but does not abort later steps either, so one bad step doesn't
# blind you to the rest of the run.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
BRIDGE="${1:-http://127.0.0.1:8000}"
PY="$HERE/.venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "WARN: $PY not found/executable; falling back to 'python3' on PATH" \
       "(see README's ERRANT/benchmark venv setup)" >&2
  PY="python3"
fi

# Per-step stdout+stderr captures — lib_summary.py parses THESE files (never
# the live terminal) to extract headline metrics + gate states.
LOGDIR="$HERE/logs/run_all"
mkdir -p "$LOGDIR"

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BRIDGE_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- bridge 2>/dev/null)" ]; then
  BRIDGE_COMMIT="${BRIDGE_COMMIT}-dirty"
fi

SUMMARY_FILE="$HERE/run_all_summary.json"
declare -A STATUS
declare -A DETAIL

record() { # record <step> <status> <detail>
  STATUS["$1"]="$2"
  DETAIL["$1"]="$3"
}

echo "======================================================================"
echo " GrammarForge eval — turnkey re-run  ($TIMESTAMP, bridge=$BRIDGE_COMMIT)"
echo "======================================================================"

# ---- Step 0: cold-restart protocol ----
if [ "${GF_SKIP_RESTART:-0}" != "1" ]; then
  COMPOSE_DIR="${GF_COMPOSE_DIR:-$REPO_ROOT}"
  echo "--- cold-restarting the LLM backend (docker compose restart llamacpp) ---"
  if (cd "$COMPOSE_DIR" && docker compose restart llamacpp) 2>&1 | tee "$LOGDIR/restart.out"; then
    echo "waiting 25s for warmup..."
    sleep 25
    record restart ok ""
  else
    echo "WARN: docker compose restart failed — results may not be cold-restart-comparable" >&2
    record restart warn "docker compose restart failed"
  fi
else
  echo "--- skipping cold restart (GF_SKIP_RESTART=1) ---"
  record restart skipped "GF_SKIP_RESTART=1"
fi

run_step() { # run_step <name> <cmd...>
  local name="$1"; shift
  echo
  echo "--- $name ---"
  # tee stdout+stderr to $LOGDIR/<name>.out; `set -o pipefail` (top of file)
  # makes the if-condition the command's own exit status, not tee's.
  if "$@" 2>&1 | tee "$LOGDIR/$name.out"; then
    record "$name" ok ""
  else
    local rc=$?
    echo "WARN: $name exited $rc" >&2
    record "$name" "fail(rc=$rc)" ""
  fi
}

# Clean-FP ceiling: baseline fp_rate (PERCENT, one decimal) + 2pp — currently
# 11.6 + 2 = 13.6. Derived from eval/clean_baseline.json so the gate follows
# a re-baselined corpus without editing this script.
# DIALECT PAIRING CAVEAT (README §8): the baseline was measured on a
# BRITISH-configured bridge; against an american-configured bridge (the
# golden/benchmark config) this step reads high and can fail spuriously —
# the canonical clean-FP gate is the separate british run (README §4/§6).
MAX_FP_RATE="$(python3 -c '
import json, sys
j = json.load(open(sys.argv[1]))
print(f"{round(j[\"fp_rate\"] * 100, 1) + 2:.1f}")
' "$HERE/clean_baseline.json" 2>/dev/null || echo 13.6)"

# ---- Step 1: golden ----
run_step golden "$PY" "$HERE/run_eval.py" "$BRIDGE" --require-exact

# ---- Step 2: clean ----
run_step clean "$PY" "$HERE/clean_eval.py" "$BRIDGE" "$HERE/clean_corpus.jsonl" \
  --max-fp-rate "$MAX_FP_RATE"

if [ "${GF_SKIP_BENCHMARKS:-0}" != "1" ]; then
  # ---- Step 3: CoNLL-2014 ----
  if [ -f "$HERE/benchmarks/conll14/official-2014.combined.m2" ]; then
    run_step conll14 "$PY" "$HERE/conll14_eval.py" "$BRIDGE"
  else
    echo; echo "--- conll14: SKIPPED (data missing; run: bash eval/get_benchmarks.sh) ---"
    record conll14 skipped "data missing"
  fi

  # ---- Step 4: BEA-2019 ----
  if [ -f "$HERE/benchmarks/bea19/ABCN.dev.gold.bea19.m2" ]; then
    run_step bea19 "$PY" "$HERE/bea19_eval.py" "$BRIDGE"
  else
    echo; echo "--- bea19: SKIPPED (data missing; run: bash eval/get_benchmarks.sh) ---"
    record bea19 skipped "data missing"
  fi
else
  echo; echo "--- conll14/bea19: SKIPPED (GF_SKIP_BENCHMARKS=1) ---"
  record conll14 skipped "GF_SKIP_BENCHMARKS=1"
  record bea19 skipped "GF_SKIP_BENCHMARKS=1"
fi

# ---- Step 5: JFLEG ----
if [ -f "$HERE/jfleg_dev.jsonl" ]; then
  run_step jfleg "$PY" "$HERE/jfleg_eval.py" "$BRIDGE"
else
  echo; echo "--- jfleg: SKIPPED (data missing; see README's JFLEG fetch recipe) ---"
  record jfleg skipped "data missing"
fi

# ---- Step 6: calibration (offline, needs golden's results.json) ----
if [ -f "$HERE/results.json" ]; then
  run_step calibration "$PY" "$HERE/calibration_eval.py" "$HERE/results.json"
else
  echo; echo "--- calibration: SKIPPED (results.json missing — golden step must run first) ---"
  record calibration skipped "results.json missing"
fi

# ---- Summary ----
echo
echo "======================================================================"
echo " SUMMARY  ($TIMESTAMP, bridge=$BRIDGE_COMMIT)"
echo "======================================================================"
printf "  %-14s %s\n" "step" "status"
for step in restart golden clean conll14 bea19 jfleg calibration; do
  printf "  %-14s %s\n" "$step" "${STATUS[$step]:-not run}"
done
echo "======================================================================"

# Hand the per-step statuses + tee'd logs to lib_summary.py: it extracts the
# headline metrics, derives each step's gate (pass|fail|skipped|error), and
# writes run_all_summary.json. With GF_GATE=1 its --gate mode exits nonzero
# on any "fail"/"error" step and we propagate that exit code.
STATUS_TSV="$LOGDIR/steps.tsv"
: > "$STATUS_TSV"
for step in restart golden clean conll14 bea19 jfleg calibration; do
  [ -n "${STATUS[$step]:-}" ] || continue
  printf '%s\t%s\t%s\n' "$step" "${STATUS[$step]}" "${DETAIL[$step]:-}" >> "$STATUS_TSV"
done

GATE_ARGS=()
if [ "${GF_GATE:-0}" = "1" ]; then
  GATE_ARGS=(--gate)
fi
summary_rc=0
python3 "$HERE/lib_summary.py" "${GATE_ARGS[@]}" "$STATUS_TSV" "$LOGDIR" \
  "$SUMMARY_FILE" "$TIMESTAMP" "$BRIDGE_COMMIT" "$BRIDGE" || summary_rc=$?
if [ "$summary_rc" -ne 0 ]; then
  if [ "${GF_GATE:-0}" = "1" ]; then
    echo "GF_GATE=1: gate failed — see $SUMMARY_FILE" >&2
    exit "$summary_rc"
  fi
  echo "WARN: summary build exited $summary_rc" >&2
fi

echo "Run metadata written to $SUMMARY_FILE"
echo "Per-step artifacts: results.json, results.latency.json, clean_corpus.runs.json,"
echo "  benchmarks/conll14/conll14_results.json, benchmarks/bea19/bea19_results.json,"
echo "  jfleg_results.json, calibration_results.json"
