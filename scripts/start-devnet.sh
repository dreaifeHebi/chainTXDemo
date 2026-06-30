#!/usr/bin/env bash
set -euo pipefail

ENCLAVE="${ENCLAVE:-tx-flight-recorder}"
ARGS_FILE="${ARGS_FILE:-network_params.yaml}"
PACKAGE="${PACKAGE:-github.com/ethpandaops/ethereum-package}"
KURTOSIS_BIN="${KURTOSIS_BIN:-kurtosis}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${PWD}/output/kurtosis/config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-${PWD}/output/kurtosis/data}"

if command -v docker >/dev/null 2>&1; then
  port_owner="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep '8081' || true)"
  if [[ -n "${port_owner}" && "${port_owner}" != kurtosis-engine--* ]]; then
    cat >&2 <<'EOF'
Docker reports that host port 8081 is already published.

Kurtosis 1.20.0 publishes its enclave-manager API on host port 8081, and this
port is not configurable in the current Docker backend. Free port 8081 before
starting the separated geth+lighthouse devnet.

Find the owner with:
  docker ps --format '{{.Names}} {{.Ports}}' | grep 8081
EOF
    exit 1
  fi
fi

if ! command -v "${KURTOSIS_BIN}" >/dev/null 2>&1; then
  cat >&2 <<'EOF'
kurtosis is required for the local PoS devnet path.

Install it first, then rerun this script:
  https://docs.kurtosis.com/install

The repo intentionally uses Kurtosis here because it keeps execution RPC
services and lighthouse beacon/validator services separate.
EOF
  exit 127
fi

echo "Starting local PoS devnet:"
echo "  enclave:   ${ENCLAVE}"
echo "  package:   ${PACKAGE}"
echo "  args file: ${ARGS_FILE}"

"${KURTOSIS_BIN}" run \
  --enclave "${ENCLAVE}" \
  "${PACKAGE}" \
  --args-file "${ARGS_FILE}"

cat <<EOF

Devnet started. Inspect services with:
  kurtosis enclave inspect ${ENCLAVE}

Then print shell exports for the execution RPC and beacon API with:
  ./scripts/print-devnet-env.sh

If the ethereum-package service names differ, pass them explicitly:
  EL_SERVICE=<execution-service> CL_SERVICE=<beacon-service> ./scripts/print-devnet-env.sh
EOF
