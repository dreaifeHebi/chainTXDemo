#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${CONTAINER:-chain-tx-anvil}"
CHAIN_ID="${CHAIN_ID:-31337}"
RPC_HOST="${RPC_HOST:-127.0.0.1}"
RPC_PORT="${RPC_PORT:-8545}"
IMAGE="${IMAGE:-ghcr.io/foundry-rs/foundry:latest}"
RPC_URL="http://${RPC_HOST}:${RPC_PORT}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run the local Anvil devnet." >&2
  exit 127
fi

rpc_ready() {
  command -v curl >/dev/null 2>&1 &&
    curl -fsS \
      -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
      "${RPC_URL}" 2>/dev/null | grep -q '"result":"0x'
}

if rpc_ready; then
  cat <<EOF
An existing execution RPC is already responding:
  RPC_URL: ${RPC_URL}

No new Anvil container was started. You can use the existing endpoint in the
Infrastructure Lab or choose another RPC_PORT/CONTAINER name.
EOF
  exit 0
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

for _ in {1..20}; do
  if rpc_ready; then
    break
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null || true)" != "true" ]]; then
    echo "Anvil container exited before its RPC became ready:" >&2
    docker logs --tail 40 "${CONTAINER}" >&2 || true
    exit 1
  fi
  sleep 0.25
done

if ! rpc_ready; then
  echo "Anvil container is running but ${RPC_URL} did not become ready." >&2
  exit 1
fi

cat <<EOF
Started Anvil execution devnet:
  container: ${CONTAINER}
  RPC_URL:   ${RPC_URL}
  chainId:   ${CHAIN_ID}

Run a real transaction and write output/live-record.json:
  RPC_URL=${RPC_URL} node scripts/run-live-transfer.mjs

This is an execution-only smoke path. Use ./scripts/start-devnet.sh for the
separated geth+lighthouse RPC/beacon/validator PoS devnet.
EOF
