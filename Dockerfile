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
 && mkdir -p /out/app/data

# Alpine instead of distroless: the health check needs curl.
FROM alpine:3.22
RUN apk add --no-cache curl
COPY --from=server /out/vibe-memory /vibe-memory
# docker-compose.yml mounts ./data here. The directory must be writable by the container user
# (10001 by default): sudo chown 10001:10001 data
COPY --from=server --chown=10001:10001 /out/app /app
WORKDIR /app
ENV ADDR=:8080 \
    DATA_DIR=/app/data \
    ALLOWED_ORIGINS= \
    MIN_FREE_MB=500 \
    LOG_LEVEL=info
EXPOSE 8080
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -fsS -o /dev/null http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/vibe-memory"]
