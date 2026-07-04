# Third-Party Notices

This repository embeds, adapts, or links against the third-party components
listed below. Notice text follows the upstream licence; verify against the
linked source before redistributing.

## VarCon (en-wl/wordlist `VarCon` archive)

- Source: https://downloads.sourceforge.net/project/wordlist/VarCon/
- Archive: `varcon-2020.12.07.tar.gz` (decoded into `varcon.txt`)
- Pinned SHA-256: `3b0720c5718008f37c02658a83d51d5598dd86531f0a2206d410c854006cb184`
- Embedded at: `bridge/internal/correction/dialect_lexicon_british.txt` (TSV derived at maintainer build time by `bridge/scripts/build-dialect-lexicon.sh`, parsed at runtime via `//go:embed` in `bridge/internal/correction/dialect_lexicon.go`).
- Maintainer: Kevin Atkinson and the en-wl contributors.
- License: permissive (BSD-style) — see the `Copyright` file at the upstream
  repository root for the canonical text. Redistribution is permitted with
  this notice retained; the upstream project does NOT require downstream
  acknowledgement beyond what is needed to satisfy their notice clause.

The embedded lexicon is regenerated only by the maintainer on vocabulary
bumps; it is NOT fetched at runtime or inside the Docker build, so the
embedded payload is the only network side-effect on first publish.
