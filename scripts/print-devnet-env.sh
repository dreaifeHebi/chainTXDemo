#!/usr/bin/env bash
set -euo pipefail

ENCLAVE="${ENCLAVE:-tx-flight-recorder}"
EL_SERVICE="${EL_SERVICE:-el-1-geth-lighthouse}"
CL_SERVICE="${CL_SERVICE:-cl-1-lighthouse-geth}"
KURTOSIS_BIN="${KURTOSIS_BIN:-kurtosis}"
DEVNET_HOST="${DEVNET_HOST:-}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${PWD}/output/kurtosis/config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-${PWD}/output/kurtosis/data}"

if ! command -v "${KURTOSIS_BIN}" >/dev/null 2>&1; then
  echo "kurtosis is required to discover devnet service ports." >&2
  exit 127
fi

first_port() {
  local service="$1"
  shift

  local port_name
  local url
  for port_name in "$@"; do
    if url="$("${KURTOSIS_BIN}" port print "${ENCLAVE}" "${service}" "${port_name}" 2>/dev/null)"; then
      if [[ -n "${url}" ]]; then
        echo "${url}"
        return 0
      fi
    fi
  done

  return 1
}

with_http_scheme() {
  local url="$1"
  if [[ "${url}" == http://* || "${url}" == https://* ]]; then
    echo "${url}"
  else
    echo "http://${url}"
  fi
}

with_host_override() {
  local url
  url="$(with_http_scheme "$1")"

  if [[ -z "${DEVNET_HOST}" ]]; then
    echo "${url}"
    return 0
  fi

  local scheme
  local rest
  local port
  scheme="${url%%://*}"
  rest="${url#*://}"
  port="${rest##*:}"
  echo "${scheme}://${DEVNET_HOST}:${port}"
}

RPC_URL="$(first_port "${EL_SERVICE}" rpc http-rpc http || true)"
BEACON_URL="$(first_port "${CL_SERVICE}" http beacon-api http-rest-api rest || true)"

if [[ -z "${RPC_URL}" || -z "${BEACON_URL}" ]]; then
  cat >&2 <<EOF
Could not infer both endpoints from the default service/port names.

Current assumptions:
  ENCLAVE=${ENCLAVE}
  EL_SERVICE=${EL_SERVICE}
  CL_SERVICE=${CL_SERVICE}

Inspect the enclave, then rerun with EL_SERVICE and CL_SERVICE set:
  kurtosis enclave inspect ${ENCLAVE}
  EL_SERVICE=<execution-service> CL_SERVICE=<beacon-service> ./scripts/print-devnet-env.sh
EOF
  exit 1
fi

printf 'export RPC_URL=%q\n' "$(with_host_override "${RPC_URL}")"
printf 'export BEACON_URL=%q\n' "$(with_host_override "${BEACON_URL}")"
