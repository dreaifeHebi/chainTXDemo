# Tx Flight Recorder

This is a first-pass demo for making on-chain state transitions visible from the
RPC boundary through txpool, Engine API, validator duties, EVM execution, and
finality.

The UI is intentionally static for this first version. It gives you a complete
offline trace snapshot for:

- native ETH transfer
- CounterVault deployment
- direct ABI contract call with `increase(7)`
- contract `receive()` ETH deposit with empty calldata
- EIP-712 dApp flow with `eth_signTypedData_v4` plus relayed ABI transaction
- `alwaysFail()` revert
- nonce gap txpool experiment
- Type 0/1/2/3/4 transaction envelope comparison
- RPC broadcast path and validator proposer/attester details

## Run the UI

Open `index.html` directly, or serve it on the LAN:

```bash
python3 -m http.server 8088 --bind 0.0.0.0
```

Docker path:

```bash
docker compose up --build
```

Then open:

```text
http://127.0.0.1:8088
```

LAN URL example:

```text
http://<host-lan-ip>:8088
```

On the current machine, replace `<host-lan-ip>` with the address from
`hostname -I`, such as `192.168.x.x`.

If `output/live-record.json` exists, the UI will automatically load it as a
`Live` transaction tab. Browser `file://` opens may block that fetch, so use the
HTTP server path when viewing live records.

## Quick real-transaction smoke path

If you only need to prove the UI can ingest a real transaction record, start a
local Anvil execution devnet:

```bash
./scripts/start-anvil-devnet.sh
node scripts/run-live-transfer.mjs
python3 -m http.server 8088 --bind 0.0.0.0
```

Then open `http://127.0.0.1:8088` and select the `Live` tab.

This path sends a real transaction to a real local JSON-RPC endpoint, but it is
execution-only. It does not model separate beacon or validator services.

## Start a separated local PoS devnet

The included `network_params.yaml` is a starting point for a geth + lighthouse
Kurtosis devnet. RPC snooping is disabled by default because it records full
Beacon/Engine API bodies and can grow by tens of GB per day. Enable it only for
short, monitored captures.

```bash
kurtosis run \
  --enclave tx-flight-recorder \
  github.com/ethpandaops/ethereum-package \
  --args-file network_params.yaml
```

Or use the wrapper:

```bash
./scripts/start-devnet.sh
```

Install the Kurtosis CLI first if it is not already available. The official
Linux path is the Kurtosis apt/yum repository or the release artifact listed in
the install guide: <https://docs.kurtosis.com/install/>.

If you use a downloaded CLI without installing it system-wide, point the wrapper
at the binary:

```bash
KURTOSIS_BIN=/tmp/kurtosis-cli-1.20.0/kurtosis ./scripts/start-devnet.sh
```

Kurtosis 1.20.0 publishes its local enclave-manager API on host port `8081`.
That port must be free before the separated PoS devnet can start.

This devnet keeps the main actors separate:

- execution RPC / txpool: geth service, used through `RPC_URL`
- consensus / beacon API: lighthouse beacon service, used through `BEACON_URL`
- validator duties: lighthouse validator clients connected to the beacon node

After the devnet is up, discover endpoint exports:

```bash
./scripts/print-devnet-env.sh
```

For another machine on the same LAN, emit URLs with the host LAN address:

```bash
DEVNET_HOST=<host-lan-ip> ./scripts/print-devnet-env.sh
```

This prints endpoints like:

```bash
export RPC_URL=http://<host-lan-ip>:<execution-rpc-port>
export BEACON_URL=http://<host-lan-ip>:<beacon-api-port>
```

If the ethereum-package service names differ, inspect the enclave and pass the
service names explicitly:

```bash
kurtosis enclave inspect tx-flight-recorder
EL_SERVICE=<execution-service> CL_SERVICE=<beacon-service> ./scripts/print-devnet-env.sh
```

Useful live sources for the next step:

- Execution API: `eth_sendRawTransaction`, `eth_getTransactionByHash`,
  `eth_getTransactionReceipt`, `eth_getBlockByHash`, `eth_getStorageAt`
- Geth txpool API: `txpool_contentFrom`, `txpool_status`
- Debug API: `debug_traceTransaction`
- Beacon API: head, finalized checkpoint, validator proposer duties
- Optional RPC snooper: Engine API calls such as `engine_forkchoiceUpdated`,
  `engine_getPayload`, and `engine_newPayload`

## Send one real local transaction

The first live path is a native ETH transfer. It writes `output/live-record.json`
with the same shape the UI already renders:

```bash
source <(./scripts/print-devnet-env.sh)
node scripts/run-live-transfer.mjs
python3 -m http.server 8088 --bind 0.0.0.0
```

For Anvil, `BEACON_URL` is not available, so run the same collector with only
`RPC_URL`:

```bash
RPC_URL=http://127.0.0.1:8545 node scripts/run-live-transfer.mjs
```

The runner supports three sender modes:

- `eth_sendTransaction` from a devnet account exposed by `eth_accounts`
- `RAW_TX=0x...` with a pre-signed transaction submitted through
  `eth_sendRawTransaction`
- `PRIVATE_KEY=0x...` with Foundry `cast` installed locally, or with Docker
  available for the `ghcr.io/foundry-rs/foundry:latest` image. Signing happens
  locally and only the resulting transaction is submitted.

Useful overrides:

```bash
RPC_URL=http://127.0.0.1:8545 \
BEACON_URL=http://127.0.0.1:5052 \
TO=0x000000000000000000000000000000000000b0b0 \
VALUE_WEI=1000000000000000 \
node scripts/run-live-transfer.mjs
```

## Current scope

The static sample records remain available. The live path now covers a real
local transfer plus RPC, txpool, receipt, debug trace, block, and optional
beacon/finality context. Contract deployment/calls and Engine API snooper
capture can reuse the same `uiTx` record shape next.
