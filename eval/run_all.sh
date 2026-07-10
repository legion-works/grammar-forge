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
  if (cd "$COMPOSE_DIR" && docker compose restart llamacpp) 2>&1; then
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
  if "$@"; then
    record "$name" ok ""
  else
    local rc=$?
    echo "WARN: $name exited $rc" >&2
    record "$name" "fail(rc=$rc)" ""
  fi
}

# ---- Step 1: golden ----
run_step golden "$PY" "$HERE/run_eval.py" "$BRIDGE"

# ---- Step 2: clean ----
run_step clean "$PY" "$HERE/clean_eval.py" "$BRIDGE" "$HERE/clean_corpus.jsonl"

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

python3 - "$SUMMARY_FILE" "$TIMESTAMP" "$BRIDGE_COMMIT" "$BRIDGE" <<'PYEOF'
import json, sys
summary_file, timestamp, bridge_commit, bridge_url = sys.argv[1:5]
# Steps + statuses are threaded through env in the shell; re-derive here from
# the already-printed STATUS assoc array isn't possible from a subshell, so
# this trailer just records the run metadata — per-step detail lives in each
# step's own persisted results file (results.json, clean*.runs.json,
# conll14_results.json, bea19_results.json, jfleg_results.json,
# calibration_results.json).
json.dump(
    {
        "timestamp": timestamp,
        "bridge_commit": bridge_commit,
        "bridge_url": bridge_url,
        "artifacts": [
            "results.json", "results.latency.json", "clean_corpus.runs.json",
            "benchmarks/conll14/conll14_results.json",
            "benchmarks/bea19/bea19_results.json",
            "jfleg_results.json", "calibration_results.json",
        ],
    },
    open(summary_file, "w"),
    indent=2,
)
PYEOF

echo "Run metadata written to $SUMMARY_FILE"
echo "Per-step artifacts: results.json, results.latency.json, clean_corpus.runs.json,"
echo "  benchmarks/conll14/conll14_results.json, benchmarks/bea19/bea19_results.json,"
echo "  jfleg_results.json, calibration_results.json"
