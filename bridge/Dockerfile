# syntax=docker/dockerfile:1
# GrammarForge bridge — full CGo build with bundled ONNX + Harper native libs.
#
# Multi-stage:
#   1. harper  — builds libharper_c.so from the VENDORED fork at
#               bridge/native/harper-c/ using a Rust toolchain that is itself
#               compiled against bookworm's glibc (rust:1-slim-bookworm).
#               A rustup-installed "stable" toolchain references newer glibc
#               symbols (e.g. log10f@GLIBC_2.43 on the host) which the
#               bookworm linker cannot resolve. The fork adds the structured
#               LintKind + dialect accessors (see native/harper-c/src/ffi.rs).
#   2. tokenizers-arm64 — builds libtokenizers.a from source for linux/arm64.
#               hugot ships only an x86_64 static archive; arm64 must build
#               its own at the exact version pinned in go.mod (daulet/tokenizers
#               v1.27.0). Same glibc-consistency constraint as the harper stage
#               → rust:1-slim-bookworm. The stage always runs (Docker builds
#               every referenced stage regardless of TARGETARCH); amd64 builds
#               cache it and discard the artifact.
#   3. bridge  — copies the freshly-built harper .so + arm64 tokenizers.a,
#               downloads ORT + tokenizers libs (branching on TARGETARCH),
#               then builds the Go binary. The .dockerignore excludes
#               bridge/native/ from the build context EXCEPT native/harper-c/
#               (the Rust source), so the linker sees only the in-image libs
#               but the source is available.
#   4. runtime — debian:bookworm-slim + the libs + the binary.
FROM rust:1-slim-bookworm AS harper
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
# Build the vendored fork (Cargo.lock pins the exact harper-core 2.4 dep set).
COPY native/harper-c/ /tmp/harper-c/
# Cache mounts persist the cargo registry + target dir across builds so an
# unchanged harper-c (the common case) relinks from cache instead of a cold
# Rust build. The cp pulls the artifact OUT of the ephemeral target cache into a
# real image path within the same RUN (cache mounts are not committed to layers).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/tmp/harper-c/target \
    (cd /tmp/harper-c && cargo build --release --locked) \
    && mkdir -p /out/harper-native \
    && cp /tmp/harper-c/target/release/libharper_c.so /out/harper-native/ \
    && cp /tmp/harper-c/src/harper.h /out/harper-native/

# --- arm64: build libtokenizers.a from source (hugot ships only x86_64 .a) ---
FROM rust:1-slim-bookworm AS tokenizers-arm64
# g++ is needed by the esaxx-rs crate (C++ linker for the tokenizers C extension).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git gcc g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
# Clone + build daulet/tokenizers at the exact version pinned in go.mod.
# Cache mounts persist the cargo registry + target dir across builds —
# unchanged source (the common case) relinks from cache.
RUN git clone --depth 1 --branch v1.27.0 https://github.com/daulet/tokenizers /tmp/tokenizers
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/tmp/tokenizers/target \
    (cd /tmp/tokenizers && cargo build --release --locked) \
    && mkdir -p /out \
    # crate name tokenizers-ffi → artifact libtokenizers_ffi.a; rename
    # to match the filename hugot + Go linker expect (libtokenizers.a).
    && cp /tmp/tokenizers/target/release/libtokenizers_ffi.a /out/libtokenizers.a

FROM golang:1.26-bookworm AS bridge
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc libc6-dev curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Pull the freshly-built harper .so + header from the harper stage.
COPY --from=harper /out/harper-native/ /src/native/
# Pull the source-built arm64 tokenizers.a — unused on amd64 (cached, discarded).
COPY --from=tokenizers-arm64 /out/libtokenizers.a /src/native/libtokenizers-arm64.a
# ONNX Runtime + tokenizers: branch on TARGETARCH.
#   amd64: download ORT + tokenizers from the hugot v0.7.5 release (prebuilt).
#   arm64: ORT from Microsoft's official release (hugot ships only x86_64 .so);
#          tokenizers from the locally-built arm64 artifact above.
# ORT version 1.26.0 — matches onnxruntime_go v1.31.0's ORT_API_VERSION 26
# and hugot's docker-bake.hcl ONNXRUNTIME_VERSION.
ARG TARGETARCH
RUN cd /src/native \
    && if [ "$TARGETARCH" = "arm64" ]; then \
         echo "-- arm64: using MS ONNX Runtime 1.26.0 + source-built tokenizers" \
         && curl -fsSL -o ort.tgz https://github.com/microsoft/onnxruntime/releases/download/v1.26.0/onnxruntime-linux-aarch64-1.26.0.tgz \
         && tar xzf ort.tgz --strip-components=2 onnxruntime-linux-aarch64-1.26.0/lib/libonnxruntime.so.1.26.0 \
         && mv libonnxruntime.so.1.26.0 libonnxruntime.so \
         && rm ort.tgz \
         && mv libtokenizers-arm64.a libtokenizers.a; \
       else \
         echo "-- amd64: using hugot v0.7.5 prebuilt libs" \
         && curl -fsSL -o libonnxruntime-linux-x64.so https://github.com/knights-analytics/hugot/releases/download/v0.7.5/libonnxruntime-linux-x64.so \
         && mv libonnxruntime-linux-x64.so libonnxruntime.so \
         && curl -fsSL -o libtokenizers.a https://github.com/knights-analytics/hugot/releases/download/v0.7.5/libtokenizers.a \
         && rm -f libtokenizers-arm64.a; \
       fi
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
ENV CGO_ENABLED=1 \
    CGO_CFLAGS="-I/src/native" \
    CGO_LDFLAGS="-L/src/native -Wl,-rpath,/usr/local/lib"
# Cache mounts persist the Go module + build caches so a source-only change (the
# COPY . . above busts this layer every time) recompiles ONLY the changed
# packages instead of a cold CGo+ONNX build of the whole module.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -tags ORT -ldflags="-s -w" -o /out/grammarforge ./cmd/grammarforge \
    && go build -tags ORT -ldflags="-s -w" -o /out/semverify-probe ./cmd/semverify-probe

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
# libonnxruntime.so + libharper_c.so need ldconfig; libtokenizers.a is
# already statically linked into the binary and does not ship.
COPY --from=bridge /src/native/libonnxruntime.so /src/native/libharper_c.so /usr/local/lib/
RUN ldconfig
# /data is the SQLite DB dir; create it writable so the bridge can create
# corrections.db on first start. For production, mount a volume here.
RUN mkdir -p /data
COPY --from=bridge /out/grammarforge /usr/local/bin/grammarforge
COPY --from=bridge /out/semverify-probe /usr/local/bin/semverify-probe
COPY models/ /models/
ENV GF_GECTOR_MODEL_DIR=/models/gector \
    GF_DB_PATH=/data/corrections.db
EXPOSE 8000 8082
ENTRYPOINT ["/usr/local/bin/grammarforge"]
