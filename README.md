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

## Interactive browser infrastructure lab

The upper-right `Infrastructure Lab` connects three boundaries independently:

- an Execution JSON-RPC endpoint for chain metadata, transaction observation,
  txpool (when exposed), receipts, blocks, traces, and safe/finalized tags
- an EIP-1193 browser wallet for account permission and user-approved signing
- an optional Beacon API endpoint for head/slot/finality context

The page never asks for or stores a private key. The wallet provider performs
the real broadcast. The Execution RPC selected in the page is an independent
observer; matching chain IDs do not prove that it is the same endpoint the
wallet used to broadcast.

For a local execution-only exercise:

```bash
./scripts/start-anvil-devnet.sh
python3 -m http.server 8088 --bind 127.0.0.1
```

Configure a browser wallet with the dev-only network/account printed by Anvil:

```text
RPC URL:  http://127.0.0.1:8545
chain ID: 31337
currency: ETH
```

The same development chain can be used through a LAN/private-network address
or a forwarded loopback port. Sending is enabled for Anvil (chain ID 31337)
and the demo PoS devnet (20230618) on loopback, RFC1918 IPv4, private mesh
addresses (100.64.0.0/10), and IPv6 unique-local addresses. Sepolia and Hoodi
are also supported. A loopback URL alone does not permit mainnet transactions.

Never reuse Anvil's public development keys on a real network. In the page,
open `Infrastructure Lab`, connect the RPC and wallet, confirm their chain IDs
match, and send a small transfer. The interactive scenario records Web input,
RPC preflight, wallet confirmation, tx hash, txpool capability, receipt, block,
trace availability, state changes, and finality tags.

For public testing, use your own HTTPS Sepolia RPC and test ETH. Sepolia is the
default application testnet; Hoodi is intended for validator/staking and
protocol-infrastructure testing. See the official
[Ethereum networks guide](https://ethereum.org/developers/docs/networks/).

Execution RPC alone cannot reveal internal Engine API calls, proposer signing,
or validator attestations. Use the separated Kurtosis PoS devnet plus its
Beacon API for consensus context. Engine API must remain an authenticated
node-internal boundary, not a browser-facing endpoint.

## Remote development and port forwarding

The JavaScript RPC requests run on the machine hosting your browser, not on the
remote machine serving these files. Forward both the page and execution RPC.
For example, run this on your own computer (replace `user@remote-host`):

```bash
ssh -N -L 127.0.0.1:8088:127.0.0.1:8088 -L 127.0.0.1:18545:127.0.0.1:8545 user@remote-host
```

Open `http://127.0.0.1:8088`, set the page's RPC URL and the wallet's network RPC
to `http://127.0.0.1:18545`, and use the chain ID actually returned by that RPC
(`31337` for the default Anvil). VS Code Remote's Ports panel can provide the
same two forwards; use its actual forwarded local addresses.

Test the forwarded endpoint **on the browser computer**:

```bash
curl --max-time 5 -i -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  http://127.0.0.1:18545
curl --max-time 5 -i -X OPTIONS -H 'Origin: http://127.0.0.1:8088' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' http://127.0.0.1:18545
```

The first response must be JSON-RPC, not a login page or HTML proxy error.
For cross-origin browser requests, OPTIONS and POST must allow the page's
origin and the preflight must allow POST and Content-Type. SSH port forwarding
passes HTTP headers through; a reverse proxy may change them. A forwarded
endpoint protected by a web login may work in a tab but fail in a wallet.

`strict-origin-when-cross-origin` is a Referrer Policy, not itself a CORS error.
Inspect the actual Console error and failed OPTIONS/POST response. Browser
mixed-content or local-network permissions can also block a request even if
curl succeeds. Prefer forwarding the page to local HTTP together with the RPC
for this local exercise. Changing fetch to `no-cors` cannot make JSON-RPC
responses readable.

## Cloudflare Pages deployment

Production domain: `https://chaintxdemo.dreaifehebi.com`.
Pages project: `chaintxdemo`, production branch: `master`.

```bash
npm ci
npm run check
npm test
npm run build
```

Only the six explicitly selected public assets are copied into `dist/`.
Local `output/live-record.json`, recordings, devnet files, secrets, and scripts
are excluded. A `404.html` prevents Pages from returning the app HTML for a
missing local recording. The public site starts with the teaching examples;
connect your RPC and wallet to start an interactive experiment.

The GitHub Actions workflow checks and builds pull requests. On a push to
`master` (or a manual run on `master`), it deploys the checked artifact with
the locked Wrangler version, creates the Pages project if absent, and attaches
the custom domain and CNAME. Existing DNS pointing elsewhere is never replaced.

Configure these repository Actions secrets once:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account containing the Pages project |
| `CLOUDFLARE_API_TOKEN` | Token with Account / Cloudflare Pages / Edit, plus Zone / Zone / Read and Zone / DNS / Edit scoped to `dreaifehebi.com` for domain setup |

After adding secrets, use Actions → Check and deploy Cloudflare Pages → Run
workflow. First-time DNS and certificate activation can take several minutes;
the workflow reports the domain status. The Pages hostname is
`https://chaintxdemo.pages.dev`.

The deployed site serves the frontend, not an Anvil instance or an RPC relay.
RPC calls still originate in your browser: use a reachable HTTPS testnet RPC,
or grant the browser's local-network permission for your private devnet.
Keep private IPs on direct connection in proxy extensions such as ZeroOmega.
Hosting the page on Cloudflare does not bypass RPC CORS or browser network
permissions. Wallet transactions require the wallet network to match the RPC.

## Current scope

The static sample records remain available. The file-backed live path covers a
real local transfer plus RPC, txpool, receipt, debug trace, block, and optional
beacon/finality context. The browser lab adds user-driven EIP-1193 transfers and
real-time observation without persisting RPC credentials or wallet secrets.
Contract deployment/calls and bounded Engine API capture can reuse the same
`uiTx` record shape next.
