#!/usr/bin/env bash
# Build bridge/internal/correction/dialect_lexicon_british.txt from the
# VarCon (Variant Conversion) word list maintained by Kevin Atkinson / the
# en-wl project. VarCon clusters English dialect pairs (US/UK/ca/AU/...)
# with tag annotations; this script extracts only the strictest
# American-primary ↔ British-primary pairs the bridge trusts.
#
# This is a MAINTAINER-ONLY dev tool. It is NEVER invoked at runtime or
# inside the Docker build. The generated TSV is committed and embedded via
# //go:embed in dialect_lexicon.go so no network calls happen in production.
#
# Idempotent: re-runs without the network when /tmp/varcon-2020.12.07 is
# already unpacked; a CACHED_TARBALL pin lets it skip the download when the
# pinned file is present at the verified hash.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_PATH="${BRIDGE_ROOT}/internal/correction/dialect_lexicon_british.txt"

# Pinned archive: BSD-style licence maintained by en-wl on SourceForge.
# Update both URL + SHA-256 together when bumping the version. The hash on
# disk is the authoritative check — never trust an unverified download.
VARCON_URL="https://downloads.sourceforge.net/project/wordlist/VarCon/2020.12.07/varcon-2020.12.07.tar.gz"
# shellcheck disable=SC2034  # documented for human readers
VARCON_VERSION="varcon-2020.12.07"
# sha256sum of the original, unmodified archive on SourceForge (computed
# at script-author time against the live download). Verify-before-extract.
VARCON_SHA256="3b0720c5718008f37c02658a83d51d5598dd86531f0a2206d410c854006cb184"

WORK="${VARCON_CACHE:-/tmp/varcon-build}"
TARBALL_PATH="${WORK}/${VARCON_VERSION}.tar.gz"
EXTRACT_DIR="${WORK}/${VARCON_VERSION}"
EXTRACT_FILE="${EXTRACT_DIR}/varcon.txt"

log() { printf '==> %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Reuse cached artefacts when present and verified — saves 25s of network
# on every lexicon rebuild during dev.
if [ -f "${EXTRACT_FILE}" ] && [ -f "${TARBALL_PATH}" ] \
   && [ "$(sha256sum "${TARBALL_PATH}" | awk '{print $1}')" = "${VARCON_SHA256}" ]; then
    log "reusing cached ${EXTRACT_FILE}"
else
    mkdir -p "${WORK}"
    if [ ! -f "${TARBALL_PATH}" ] \
       || [ "$(sha256sum "${TARBALL_PATH}" | awk '{print $1}')" != "${VARCON_SHA256}" ]; then
        log "downloading ${VARCON_URL}"
        # -f fail on HTTP >=400, -L follow SourceForge's master mirror redirect,
        # --retry 3 to ride out transient SourceForge flakes.
        if ! curl -fL --retry 3 --max-time 120 -o "${TARBALL_PATH}" "${VARCON_URL}"; then
            rm -f "${TARBALL_PATH}"
            fail "download failed: ${VARCON_URL}"
        fi
    fi
    log "verifying tarball sha256"
    ACTUAL="$(sha256sum "${TARBALL_PATH}" | awk '{print $1}')"
    if [ "${ACTUAL}" != "${VARCON_SHA256}" ]; then
        rm -f "${TARBALL_PATH}"
        fail "sha256 mismatch: got ${ACTUAL}, expected ${VARCON_SHA256}"
    fi
    log "extracting ${TARBALL_PATH}"
    rm -rf "${EXTRACT_DIR}"
    mkdir -p "${EXTRACT_DIR}"
    # --strip-components=1 drops the archive's top-level `varcon-2020.12.07/`
    # wrapper so EXTRACT_DIR directly contains varcon.txt.
    tar -xzf "${TARBALL_PATH}" --strip-components=1 -C "${EXTRACT_DIR}"
fi

[ -f "${EXTRACT_FILE}" ] || fail "expected ${EXTRACT_FILE} after extract"

mkdir -p "$(dirname "${OUT_PATH}")"
log "parsing varcon.txt -> ${OUT_PATH}"
# Embedded Python: VarCon's cluster lines need a real grammar-aware parser
# (tag blobs, exclusions, |annotations, multi-pair lines), which is not
# maintainable in bash. The Python below is stdlib-only (no requests / no
# pandas — this script must run anywhere Python 3 is available offline).
python3 - "${EXTRACT_FILE}" "${OUT_PATH}" <<'PY'
"""Extract A-primary -> B-primary pairs from a VarCon varcon.txt file.

The grammar is informal but observed patterns include:
    A Bv C: color / B C D: colour           # simple cluster
    A Z: organize / B: organise            # Z = -ize sub-class on the A side
    A B: accursed / AV B-: accurst         # B- excluded -> drop line
    A B: advertize / A-: advertize         # A- excluded -> drop line
    _: alumni / _-: alumnuses              # '_' is unknown-dialect -> skip
    A B: accursed / x: foo                 # 'x' / '-' = improper / non-standard
    A B: absinthe / AV B: absinth | :1     # '|' = POS-context annotation -> drop

We keep only the simplest primary cross-pair per line: the FIRST side whose
tag blob contains primary 'A' (no exclusion marker) is paired with the FIRST
side whose tag blob contains primary 'B' (no exclusion marker). Both words
must be single lowercase ASCII alphabetic tokens and must differ.

Arguments: sys.argv[1] is the varcon.txt path; sys.argv[2] is the output TSV.
"""
import re
import sys
from pathlib import Path

EXCLUDE_MARKERS = {"x", "-"}            # markers on a tag that disqualify its primary
TAG_RE = re.compile(r"^[A-Z][vx.?\-]?$") # a valid dialect tag token
ANNOTATION_RE = re.compile(r"\|")       # POS / context annotation marker


def _tag_blob_has_primary(tag_blob: str, primary: str) -> bool:
    """Does this tag blob contain a primary 'primary' tag WITHOUT exclusion?

    "Primary" means the bare letter ('A' / 'B') optionally refined with 'v'
    (variant / secondary in same dialect), '.' (lower-than-'v' agreement), or
    '?' (unsure). The exclusion markers 'x' and '-' mean non-standard /
    improper forms we never want to embed — any primary slot that carries
    them disqualifies the entry.
    """
    bare_seen = False
    for tok in tag_blob.split():
        if not TAG_RE.fullmatch(tok):
            continue
        letter = tok[0]
        mods = set(tok[1:])
        if letter != primary:
            continue
        if mods & EXCLUDE_MARKERS:
            return False
        bare_seen = True
    return bare_seen


def _first_word(side_text: str) -> str | None:
    """First whitespace-delimited word on the right side of ': '."""
    if ":" not in side_text:
        return None
    _, _, words_raw = side_text.partition(":")
    for tok in words_raw.split():
        tok = tok.strip()
        if tok:
            return tok
    return None


def _clean(word: str) -> str | None:
    if not word or not word.isalpha() or not word.isascii() or not word.islower():
        return None
    return word


def extract_pair(line: str) -> tuple[str, str] | None:
    """Pull (american, british) from one cluster line, or None."""
    line = line.split("#", 1)[0].strip()
    if not line or ANNOTATION_RE.search(line):
        return None
    sides = [s.strip() for s in line.split(" / ") if s.strip()]
    if len(sides) < 2:
        return None

    # First A-bearing side wins.
    us_side = next(
        (s for s in sides if ":" in s and _tag_blob_has_primary(s.partition(":")[0], "A")),
        None,
    )
    if us_side is None:
        return None

    # First B-bearing side (NOT the same as us_side — otherwise we'd be
    # double-pairing a degenerate cluster where both letters appear on the
    # same side, which can never produce a real Am->Br pair).
    gb_side = next(
        (
            s for s in sides
            if s != us_side and ":" in s and _tag_blob_has_primary(s.partition(":")[0], "B")
        ),
        None,
    )
    if gb_side is None:
        return None

    us = _clean(_first_word(us_side) or "")
    gb = _clean(_first_word(gb_side) or "")
    if us is None or gb is None or us == gb:
        return None
    return us, gb


def main(argv: list[str]) -> int:
    src, out_path = argv[1], argv[2]
    text = Path(src).read_text(encoding="utf-8", errors="replace")
    pairs: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        pair = extract_pair(line)
        if pair is not None:
            # last-wins on duplicate keys: deterministic under sort downstream.
            pairs[pair[0]] = pair[1]
    sorted_pairs = sorted(pairs.items())
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        for us, gb in sorted_pairs:
            f.write(f"{us}\t{gb}\n")
    # Diagnostic summary on stderr so the maintainer sees the result even
    # when stdout is redirected.
    print(f"wrote {len(sorted_pairs)} pairs -> {out}", file=sys.stderr)
    core = ("color", "organize", "theater")
    for us in core:
        want = {"color": "colour", "organize": "organise", "theater": "theatre"}[us]
        got = pairs.get(us)
        if got != want:
            print(
                f"WARNING: core pair {us}->{got!r} (want {want!r})",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
PY

log "done"
