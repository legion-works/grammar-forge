# syntax=docker/dockerfile:1
FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO_ENABLED=0 for Plan 1A (no CGo yet); Plans 1C flip this on with native libs.
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/grammarforge ./cmd/grammarforge

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/grammarforge /usr/local/bin/grammarforge
EXPOSE 8000 8082
ENTRYPOINT ["/usr/local/bin/grammarforge"]
