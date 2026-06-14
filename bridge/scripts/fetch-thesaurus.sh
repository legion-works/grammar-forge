#!/usr/bin/env bash
# Fetch the Moby Thesaurus II dataset (Grady Ward, 1996 — PUBLIC DOMAIN)
# for offline /synonyms lookups. Mirrors scripts/fetch-models.sh: idempotent,
# resumable via a .partial file, and prints a clear "already present" line
# on re-runs so deploy loops are no-ops.
#
# Public-repo hygiene: Moby Thesaurus II is released to the public domain
# by the author (no attribution required, no copyleft). Confirmed via the
# Project Gutenberg header shipped with the file. The data is bundled into
# the bridge container at deploy time (see docker-compose.yml); the .txt
# itself is gitignored at bridge/data/ — never committed.
set -euo pipefail

# Accept an explicit destination, default to the path the bridge's
# default GF_THESAURUS_PATH (/data/mthesaur.txt) maps to on the host.
# Falls back to bridge/data/mthesaur.txt when the script is run from
# the repo root on a developer machine.
DEST="${1:-bridge/data/mthesaur.txt}"
mkdir -p "$(dirname "$DEST")"

if [ -f "$DEST" ]; then
  echo "Already present: $DEST ($(du -h "$DEST" | cut -f1))"
  exit 0
fi

# Project Gutenberg mirror is the canonical source. If the canonical
# URL flakes (Gutenberg has been known to rate-limit or 503 on large
# pulls), fall back to the Internet Archive mirror, which is the same
# public-domain text under a stable URL.
URLS=(
  "https://www.gutenberg.org/files/3202/files/mthesaur.txt"
  "https://archive.org/download/moby-thesaurus-II-1996/mthesaur.txt"
)

for URL in "${URLS[@]}"; do
  echo "==> fetching Moby Thesaurus II from $URL"
  if curl -fL --retry 5 -C - -o "$DEST.partial" "$URL"; then
    mv "$DEST.partial" "$DEST"
    echo "==> Downloaded Moby Thesaurus II (public domain) to $DEST ($(du -h "$DEST" | cut -f1))"
    exit 0
  fi
  echo "    $URL failed; trying next mirror"
done

echo "ERROR: all mirrors failed for Moby Thesaurus II" >&2
rm -f "$DEST.partial"
exit 1
