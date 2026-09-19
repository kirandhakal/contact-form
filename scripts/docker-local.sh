#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

IMAGE="${IMAGE:-contact-backend:local}"
NETWORK="${NETWORK:-contact-backend-net}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-contact-postgres}"
APP_CONTAINER="${APP_CONTAINER:-contact-backend}"
WORKER_CONTAINER="${WORKER_CONTAINER:-contact-worker}"

if [ ! -f ".env.docker" ]; then
  echo "Missing .env.docker. Copy .env.docker.example to .env.docker and set real values."
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env.docker
set +a

APP_PORT="${APP_PORT:-3100}"

echo "Building API image: $IMAGE"
docker build -t "$IMAGE" .

echo "Preparing Docker network: $NETWORK"
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null

echo "Starting Postgres"
docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$POSTGRES_CONTAINER" \
  --network "$NETWORK" \
  --network-alias postgres \
  -e POSTGRES_USER=forms \
  -e POSTGRES_PASSWORD=forms \
  -e POSTGRES_DB=forms \
  -p 127.0.0.1:5432:5432 \
  -v contact-postgres-data:/var/lib/postgresql/data \
  postgres:17-alpine >/dev/null

echo "Waiting for Postgres"
for i in $(seq 1 30); do
  if docker exec "$POSTGRES_CONTAINER" pg_isready -U forms -d forms >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Postgres did not become ready in time."
    docker logs "$POSTGRES_CONTAINER"
    exit 1
  fi
  sleep 1
done

echo "Applying migrations"
docker run --rm \
  --network "$NETWORK" \
  --env-file .env.docker \
  "$IMAGE" \
  node dist/db/migrate.js

echo "Starting API and worker"
docker rm -f "$APP_CONTAINER" "$WORKER_CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$APP_CONTAINER" \
  --network "$NETWORK" \
  --env-file .env.docker \
  -p "$APP_PORT:3100" \
  "$IMAGE" >/dev/null

docker run -d \
  --name "$WORKER_CONTAINER" \
  --network "$NETWORK" \
  --env-file .env.docker \
  "$IMAGE" \
  node dist/worker.js >/dev/null

echo "Waiting for API readiness"
for i in $(seq 1 30); do
  if docker exec "$APP_CONTAINER" node -e "require('http').get('http://127.0.0.1:3100/health/ready', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"; then
    echo "API is ready at http://localhost:$APP_PORT"
    exit 0
  fi
  sleep 1
done

echo "API did not become ready in time."
docker logs "$APP_CONTAINER"
exit 1
