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

## Start a real PoS devnet

The included `network_params.yaml` is a starting point for a geth + lighthouse
Kurtosis devnet with RPC snooper enabled:

```bash
kurtosis run \
  --enclave tx-flight-recorder \
  github.com/ethpandaops/ethereum-package \
  --args-file network_params.yaml
```

Useful live sources for the next step:

- Execution API: `eth_sendRawTransaction`, `eth_getTransactionByHash`,
  `eth_getTransactionReceipt`, `eth_getBlockByHash`, `eth_getStorageAt`
- Geth txpool API: `txpool_contentFrom`, `txpool_status`
- Debug API: `debug_traceTransaction`
- Beacon API: head, finalized checkpoint, validator proposer duties
- RPC snooper: Engine API calls such as `engine_forkchoiceUpdated`,
  `engine_getPayload`, and `engine_newPayload`

## Current scope

This version is a front-end flight-recorder prototype with deterministic sample
records. It does not sign or submit real transactions yet. The next useful cut
is a small collector process that queries Kurtosis service endpoints and writes
the same record shape that the UI already renders.
