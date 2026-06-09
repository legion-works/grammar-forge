#!/usr/bin/env bash
# Fetch the standard GEC benchmark data + the Python-3 m2scorer port into
# eval/benchmarks/ (GITIGNORED — non-redistributable corpora). Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
B="$HERE/benchmarks"
mkdir -p "$B/conll14" "$B/bea19"

# --- CoNLL-2014 test (NUS NUCLE-derived; non-redistribution) ---
if [ ! -f "$B/conll14/official-2014.combined.m2" ]; then
  echo "Downloading CoNLL-2014 test data..."
  curl -fL -o "$B/conll14/conll14st-test.tar.gz" \
    "https://www.comp.nus.edu.sg/~nlp/conll14st/conll14st-test-data.tar.gz"
  tar -xzf "$B/conll14/conll14st-test.tar.gz" -C "$B/conll14" --strip-components=0
  # locate the 2-annotator combined M2 and normalise its path
  found="$(find "$B/conll14" -name 'official-2014.combined.m2' | head -1)"
  cp "$found" "$B/conll14/official-2014.combined.m2" 2>/dev/null || true
fi

# --- BEA-2019 W&I+LOCNESS v2.1 dev (Cambridge; non-commercial) ---
if [ ! -f "$B/bea19/ABCN.dev.gold.bea19.m2" ]; then
  echo "Downloading BEA-2019 W&I+LOCNESS v2.1..."
  curl -fL -o "$B/bea19/wilocness.tar.gz" \
    "https://www.cl.cam.ac.uk/research/nl/bea2019st/data/wi+locness_v2.1.bea19.tar.gz"
  tar -xzf "$B/bea19/wilocness.tar.gz" -C "$B/bea19"
  found="$(find "$B/bea19" -name 'ABCN.dev.gold.bea19.m2' | head -1)"
  cp "$found" "$B/bea19/ABCN.dev.gold.bea19.m2" 2>/dev/null || true
fi

# --- m2scorer Python-3 port (official is Py2-only) ---
if [ ! -d "$B/m2scorer/.git" ] && [ ! -f "$B/m2scorer/m2scorer" ]; then
  echo "Cloning m2scorer (Python 3 port)..."
  git clone --depth 1 https://github.com/Katsumata420/m2scorer_python3 "$B/m2scorer"
fi

echo
echo "Done. eval/benchmarks/ is GITIGNORED (NUS NUCLE + Cambridge W&I+LOCNESS are"
echo "non-redistributable; do not commit). Files:"
echo "  CoNLL-2014 gold:  $B/conll14/official-2014.combined.m2"
echo "  BEA-2019 dev gold: $B/bea19/ABCN.dev.gold.bea19.m2"
echo "  m2scorer:          $B/m2scorer/"
