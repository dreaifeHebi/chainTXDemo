#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${CONTAINER:-chain-tx-anvil}"
CHAIN_ID="${CHAIN_ID:-31337}"
RPC_HOST="${RPC_HOST:-127.0.0.1}"
RPC_PORT="${RPC_PORT:-8545}"
IMAGE="${IMAGE:-ghcr.io/foundry-rs/foundry:latest}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run the local Anvil devnet." >&2
  exit 127
fi

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  docker rm -f "${CONTAINER}" >/dev/null
fi

docker run -d \
  --name "${CONTAINER}" \
  --network host \
  "${IMAGE}" \
  anvil \
  --host "${RPC_HOST}" \
  --port "${RPC_PORT}" \
  --chain-id "${CHAIN_ID}" >/dev/null

cat <<EOF
Started Anvil execution devnet:
  container: ${CONTAINER}
  RPC_URL:   http://${RPC_HOST}:${RPC_PORT}
  chainId:   ${CHAIN_ID}

Run a real transaction and write output/live-record.json:
  RPC_URL=http://${RPC_HOST}:${RPC_PORT} node scripts/run-live-transfer.mjs

This is an execution-only smoke path. Use ./scripts/start-devnet.sh for the
separated geth+lighthouse RPC/beacon/validator PoS devnet.
EOF
