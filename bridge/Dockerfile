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
#   2. bridge  — copies the freshly-built harper .so + downloads the
#               hugot-bundled ORT + tokenizers libs, then builds the Go
#               binary. The .dockerignore excludes bridge/native/ from the
#               build context EXCEPT native/harper-c/ (the Rust source), so the
#               linker sees only the in-image libs but the source is available.
#   3. runtime — debian:bookworm-slim + the libs + the binary.
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

FROM golang:1.26-bookworm AS bridge
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc libc6-dev curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Pull the freshly-built harper .so + header from the harper stage.
COPY --from=harper /out/harper-native/ /src/native/
# ORT + tokenizers are downloaded from the hugot v0.7.5 GitHub release
# (individual files, not tarballs). The .so is renamed to drop the
# platform suffix; the tokenizers .a is used as-is (statically linked).
RUN cd /src/native \
    && curl -fsSL -o libonnxruntime-linux-x64.so https://github.com/knights-analytics/hugot/releases/download/v0.7.5/libonnxruntime-linux-x64.so \
    && curl -fsSL -o libtokenizers.a https://github.com/knights-analytics/hugot/releases/download/v0.7.5/libtokenizers.a \
    && mv libonnxruntime-linux-x64.so libonnxruntime.so
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
    go build -tags ORT -ldflags="-s -w" -o /out/grammarforge ./cmd/grammarforge

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
COPY models/ /models/
ENV GF_GECTOR_MODEL_DIR=/models/gector \
    GF_DB_PATH=/data/corrections.db
EXPOSE 8000 8082
ENTRYPOINT ["/usr/local/bin/grammarforge"]
