# syntax=docker/dockerfile:1
# One image: the Go server with the PWA built into it. Build from the repository root:
#   docker buildx build --platform linux/amd64,linux/arm64 --build-arg VERSION=1.0.0 -t <user>/vibe-memory:1.0.0 --push .

# The web build does not depend on the target CPU, so it runs on the builder's platform.
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /src/pwa-mobile-client
COPY pwa-mobile-client/package.json pwa-mobile-client/package-lock.json ./
RUN npm ci
COPY pwa-mobile-client/ ./
RUN npm run build

# modernc.org/sqlite is pure Go: cross-compile without CGO instead of emulating the target.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS server
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=web /src/pwa-mobile-client/dist ./internal/web/dist
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/vibe-memory ./cmd/api \
 && mkdir /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/vibe-memory /vibe-memory
# Mount the host directory here (docker-compose.yml uses ./data next to this file). On Linux it must be
# writable by uid 65532: sudo chown 65532:65532 data
COPY --from=server --chown=65532:65532 /out/data /data
ENV ADDR=:8080 \
    DATA_DIR=/data \
    ALLOWED_ORIGINS= \
    MIN_FREE_MB=500 \
    LOG_LEVEL=info
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/vibe-memory"]
