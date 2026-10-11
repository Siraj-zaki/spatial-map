# Build stage
FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /build/api ./cmd/api

# Runtime stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/api /app/api
COPY --from=builder /build/migrations /app/migrations

# Non-root user
RUN groupadd -r sgv && useradd -r -g sgv sgv \
    && chown -R sgv:sgv /app
USER sgv

EXPOSE 8080

ENTRYPOINT ["/app/api"]
