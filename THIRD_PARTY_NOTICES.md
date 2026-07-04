# Third-Party Notices

This repository embeds, adapts, or links against the third-party components
listed below. Notice text follows the upstream licence; verify against the
linked source before redistributing.

## VarCon (en-wl/wordlist `VarCon` archive)

- Source: https://downloads.sourceforge.net/project/wordlist/VarCon/
- Archive: `varcon-2020.12.07.tar.gz` (decoded into `varcon.txt`)
- Pinned SHA-256: `3b0720c5718008f37c02658a83d51d5598dd86531f0a2206d410c854006cb184`
- Embedded at: `bridge/internal/correction/dialect_lexicon_british.txt` (TSV derived at maintainer build time by `bridge/scripts/build-dialect-lexicon.sh`, parsed at runtime via `//go:embed` in `bridge/internal/correction/dialect_lexicon.go`).
- Maintainers: Kevin Atkinson, Benjamin Titze, and the en-wl contributors.
- License: the canonical permission text is the **"Copyright" section of the
  archive's `README` file** (lines ~526-580 of `varcon-2020.12.07/README`).
  It carries three permissive notices — Atkinson (2000-2019) and Titze (2016)
  under MIT-style terms, plus Geoff Kuenning (1993) under a slightly more
  restrictive BSD-style notice inherited from Ispell. There is no separate
  `Copyright` file in the extracted archive; the README section is the
  canonical text.

### Modifications (Kuenning clause 3)

> 3. All modifications to the source code must be clearly marked as such.
>    Binary redistributions based on modified source code must be clearly
>    marked as modified versions in the documentation and/or other materials
>    provided with the distribution.

The embedded `dialect_lexicon_british.txt` is a **derived, filtered subset**
of `varcon.txt`. It is **not** the upstream wordlist verbatim. The
transformation is implemented in `bridge/scripts/build-dialect-lexicon.sh`
and is summarised here to satisfy the "clearly marked as modified"
requirement:

1. Only lines where the American side carries a primary `A` tag and the
   British side carries a primary `B` tag (no exclusion markers `-`/`x`,
   no `|` POS/context annotations) are kept.
2. The first such pair per line becomes the entry; multi-pair lines and
   any line where both sides carry the same word are skipped.
3. Keys are normalized to lowercase single ASCII tokens, sorted by key
   on output.
4. A small blocklist (with per-entry justification) drops four
   upstream-data classes that would misfire on real prose: the
   `micrograms → nanogrammes` copy-paste typo at varcon.txt line 32543
   (a 1000× unit-magnitude semantic flip), plus `sync`, `dis`, `ha`,
   `et` — short/rare tokens where the modern British register matches
   American usage and a revert would be high-noise for the user.

The blocklist is a constant in the build script; see the comment there
for the line citations. To regenerate the TSV against a fresh
`varcon.txt`, re-run `bash bridge/scripts/build-dialect-lexicon.sh`
(verified-against SHA only — never trust an unverified download).

### Permission text

```
Copyright 2000-2019 by Kevin Atkinson

Permission to use, copy, modify, distribute and sell this array, the
associated software, and its documentation for any purpose is hereby
granted without fee, provided that the above copyright notice appears
in all copies and that both that copyright notice and this permission
notice appear in supporting documentation. Kevin Atkinson makes no
representations about the suitability of this array for any purpose.
It is provided "as is" without express or implied warranty.

Copyright 2016 by Benjamin Titze

Permission to use, copy, modify, distribute and sell this array, the
associated software, and its documentation for any purpose is hereby
granted without fee, provided that the above copyright notice appears
in all copies and that both that copyright notice and this permission
notice appear in supporting documentation. Benjamin Titze makes no
representations about the suitability of this array for any purpose.
It is provided "as is" without express or implied warranty.

Since the original words lists come from the Ispell distribution:

Copyright 1993, Geoff Kuenning, Granada Hills, CA
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in
   the documentation and/or other materials provided with the
   distribution.
3. All modifications to the source code must be clearly marked as
   such.  Binary redistributions based on modified source code must
   be clearly marked as modified versions in the documentation
   and/or other materials provided with the distribution.
(clause 4 removed with permission from Geoff Kuenning)
5. The name of Geoff Kuenning may not be used to endorse or promote
   products derived from this software without specific prior written
   permission.

THIS SOFTWARE IS PROVIDED BY GEOFF KUENNING AND CONTRIBUTORS ``AS IS''
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED.
```

The embedded lexicon is regenerated only by the maintainer on vocabulary
bumps; it is NOT fetched at runtime or inside the Docker build, so the
embedded payload is the only network side-effect on first publish.
