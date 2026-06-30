#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const HELP = `
Run one real ETH transfer against a local execution RPC and write a UI record.

Required environment:
  RPC_URL      Execution JSON-RPC URL. Default: http://127.0.0.1:8545

Optional environment:
  BEACON_URL   Beacon REST API URL for head/finality context.
  FROM         Sender address for eth_sendTransaction when the node has an unlocked account.
  TO           Recipient address. Default: 0x000000000000000000000000000000000000b0b0
  VALUE_WEI    Transfer value in wei. Default: 1000000000000000
  RAW_TX       Pre-signed raw transaction. If set, the script uses eth_sendRawTransaction.
  PRIVATE_KEY  Sender private key. Requires Foundry cast to sign and send.
  OUTPUT       Output JSON path. Default: output/live-record.json

Examples:
  RPC_URL=http://127.0.0.1:8545 BEACON_URL=http://127.0.0.1:5052 node scripts/run-live-transfer.mjs
  RAW_TX=0x... RPC_URL=http://127.0.0.1:8545 node scripts/run-live-transfer.mjs
  PRIVATE_KEY=0x... RPC_URL=http://127.0.0.1:8545 node scripts/run-live-transfer.mjs
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP.trim());
  process.exit(0);
}

const env = process.env;
const rpcUrl = env.RPC_URL || "http://127.0.0.1:8545";
const beaconUrl = env.BEACON_URL || "";
const outputPath = env.OUTPUT || "output/live-record.json";
const to = normalizeAddress(env.TO || "0x000000000000000000000000000000000000b0b0", "TO");
const valueWei = parseWei(env.VALUE_WEI || "1000000000000000");

let rpcId = 1;
const t0 = Date.now();

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

async function main() {
  const chainId = await rpc("eth_chainId");
  const blockBefore = await rpc("eth_blockNumber");
  const accounts = (await tryRpc("eth_accounts", [])) || [];
  const fromCandidate = normalizeOptionalAddress(env.FROM || accounts[0] || "", "FROM");

  const beforeFromBalance = fromCandidate
    ? await tryRpc("eth_getBalance", [fromCandidate, "latest"])
    : null;
  const beforeToBalance = await tryRpc("eth_getBalance", [to, "latest"]);
  const beforeFromNonce = fromCandidate
    ? await tryRpc("eth_getTransactionCount", [fromCandidate, "pending"])
    : null;

  const sendResult = await sendTransfer({ fromCandidate });
  const txHash = sendResult.txHash;

  const tx = await waitForTransaction(txHash);
  const sender = normalizeOptionalAddress(tx?.from || fromCandidate || "", "transaction.from");
  const txpoolBeforeReceipt = sender ? await txpoolRows(sender, tx?.nonce) : missingTxpoolRows("sender unknown");

  const receipt = await waitForReceipt(txHash);
  const block = receipt.blockHash
    ? await tryRpc("eth_getBlockByHash", [receipt.blockHash, false])
    : null;
  const traceRows = await debugTraceRows(txHash);

  const afterFromBalance = sender ? await tryRpc("eth_getBalance", [sender, "latest"]) : null;
  const afterToBalance = await tryRpc("eth_getBalance", [to, "latest"]);
  const afterFromNonce = sender ? await tryRpc("eth_getTransactionCount", [sender, "latest"]) : null;

  const beaconRows = await beaconContextRows();
  const record = buildRecord({
    chainId,
    blockBefore,
    accounts,
    fromCandidate,
    beforeFromBalance,
    beforeFromNonce,
    beforeToBalance,
    sendResult,
    tx,
    txHash,
    sender,
    txpoolBeforeReceipt,
    receipt,
    block,
    traceRows,
    afterFromBalance,
    afterFromNonce,
    afterToBalance,
    beaconRows,
  });

  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(record, null, 2) + "\n");

  console.log(`sent ${txHash}`);
  console.log(`wrote ${outputPath}`);
}

async function sendTransfer({ fromCandidate }) {
  if (env.RAW_TX) {
    const txHash = await rpc("eth_sendRawTransaction", [env.RAW_TX]);
    return {
      mode: "eth_sendRawTransaction",
      txHash,
      method: "eth_sendRawTransaction",
      detail: "pre-signed RAW_TX bytes were submitted to the execution RPC",
    };
  }

  if (env.PRIVATE_KEY) {
    return sendWithCast();
  }

  if (fromCandidate) {
    try {
      const txHash = await rpc("eth_sendTransaction", [
        {
          from: fromCandidate,
          to,
          value: hexQuantity(valueWei),
        },
      ]);
      return {
        mode: "eth_sendTransaction",
        txHash,
        method: "eth_sendTransaction",
        detail: "execution node used an unlocked devnet account",
      };
    } catch (error) {
      throw new Error(
        [
          "eth_sendTransaction failed. The node may not have an unlocked account.",
          `RPC error: ${error.message}`,
          "Set RAW_TX to submit a pre-signed transaction, or set PRIVATE_KEY and install Foundry cast.",
        ].join("\n"),
      );
    }
  }

  throw new Error(
    [
      "No usable sender was found.",
      "Set FROM for an unlocked devnet account, RAW_TX for a pre-signed transaction,",
      "or PRIVATE_KEY if Foundry cast is installed.",
    ].join("\n"),
  );
}

function sendWithCast() {
  const probe = spawnSync("cast", ["--version"], { encoding: "utf8" });
  const hasLocalCast = probe.status === 0;

  const castArgs = [
      "send",
      "--rpc-url",
      rpcUrl,
      "--private-key",
      env.PRIVATE_KEY,
      to,
      "--value",
      `${valueWei.toString()}wei`,
      "--json",
  ];

  const result = hasLocalCast
    ? spawnSync("cast", castArgs, { encoding: "utf8" })
    : spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "host",
          "ghcr.io/foundry-rs/foundry:latest",
          `cast ${castArgs.map(shellQuote).join(" ")}`,
        ],
        { encoding: "utf8" },
      );

  if (result.status !== 0) {
    const runner = hasLocalCast ? "cast" : "dockerized cast";
    throw new Error(`${runner} send failed:\n${result.stderr || result.stdout}`);
  }

  const txHash = parseTxHash(`${result.stdout}\n${result.stderr}`);
  if (!txHash) {
    throw new Error(`cast send did not print a transaction hash:\n${result.stdout}`);
  }

  return {
    mode: hasLocalCast ? "cast" : "dockerized-cast",
    txHash,
    method: "cast send",
    detail: hasLocalCast
      ? "cast signed locally with PRIVATE_KEY and submitted the transaction"
      : "Foundry cast in Docker signed with PRIVATE_KEY and submitted the transaction",
  };
}

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method,
      params,
    }),
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON-RPC response for ${method}: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${method}: ${text}`);
  }
  if (payload.error) {
    throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
  }

  return payload.result;
}

async function tryRpc(method, params = []) {
  try {
    return await rpc(method, params);
  } catch {
    return null;
  }
}

async function waitForTransaction(txHash) {
  for (let i = 0; i < 30; i += 1) {
    const tx = await tryRpc("eth_getTransactionByHash", [txHash]);
    if (tx) return tx;
    await sleep(500);
  }
  throw new Error(`transaction ${txHash} was not visible through eth_getTransactionByHash`);
}

async function waitForReceipt(txHash) {
  const timeoutMs = Number(env.RECEIPT_TIMEOUT_MS || "120000");
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const receipt = await tryRpc("eth_getTransactionReceipt", [txHash]);
    if (receipt) return receipt;
    await sleep(1000);
  }

  throw new Error(`timed out waiting for receipt ${txHash}`);
}

async function txpoolRows(sender, nonce) {
  const fromRows = await tryRpc("txpool_contentFrom", [sender]);
  if (fromRows) {
    return summarizeTxpool(fromRows, nonce, "txpool_contentFrom");
  }

  const allRows = await tryRpc("txpool_content", []);
  if (allRows) {
    const scoped = {
      pending: allRows.pending?.[sender.toLowerCase()] || allRows.pending?.[sender] || {},
      queued: allRows.queued?.[sender.toLowerCase()] || allRows.queued?.[sender] || {},
    };
    return summarizeTxpool(scoped, nonce, "txpool_content");
  }

  return missingTxpoolRows("txpool namespace unavailable");
}

function summarizeTxpool(content, nonce, method) {
  const pending = countSection(content.pending);
  const queued = countSection(content.queued);
  const status = pending > 0 ? "pending" : queued > 0 ? "queued" : "not present";
  return [
    [
      "local execution node",
      at(),
      status,
      nonce ? `nonce ${hexToDecimal(nonce)}` : "nonce unknown",
      `${method}: pending=${pending}, queued=${queued}`,
      3,
    ],
  ];
}

function missingTxpoolRows(reason) {
  return [["local execution node", at(), "unknown", "-", reason, 3]];
}

function countSection(section) {
  if (!section || typeof section !== "object") return 0;
  let count = 0;
  for (const value of Object.values(section)) {
    if (Array.isArray(value)) count += value.length;
    else if (value && typeof value === "object" && ("hash" in value || "from" in value)) count += 1;
    else if (value && typeof value === "object") count += countSection(value);
  }
  return count;
}

async function debugTraceRows(txHash) {
  const callTrace = await tryRpc("debug_traceTransaction", [txHash, { tracer: "callTracer" }]);
  if (callTrace) {
    return [
      ["CALL", callTrace.gasUsed || "-", `from ${short(callTrace.from)} to ${short(callTrace.to)}`, 5],
      [callTrace.error ? "ERROR" : "RETURN", "0", callTrace.error || "callTracer completed", 5],
    ];
  }

  const trace = await tryRpc("debug_traceTransaction", [txHash]);
  if (trace?.structLogs) {
    const last = trace.structLogs.at(-1);
    return [
      ["structLogs", String(trace.structLogs.length), "debug_traceTransaction returned opcode trace", 5],
      [last?.op || "last", String(last?.gasCost ?? "-"), `pc=${last?.pc ?? "-"}`, 5],
    ];
  }

  return [["debug_traceTransaction", "-", "debug API unavailable or disabled on this RPC", 5]];
}

async function beaconContextRows() {
  if (!beaconUrl) {
    return {
      builder: [["beacon REST", "not configured", "BEACON_URL", "set BEACON_URL to include validator/finality context", 4]],
      finality: [["latest", at(), "execution receipt exists", 5]],
    };
  }

  const head = await beaconGet("/eth/v1/beacon/headers/head");
  const finality = await beaconGet("/eth/v1/beacon/states/head/finality_checkpoints");
  const headSlot = head?.data?.header?.message?.slot;
  const finalizedEpoch = finality?.data?.finalized?.epoch;
  const justifiedEpoch = finality?.data?.current_justified?.epoch;

  return {
    builder: [
      ["beacon REST", beaconUrl, "head", headSlot ? `head slot ${headSlot}` : "head unavailable", 4],
      [
        "beacon REST",
        beaconUrl,
        "finality_checkpoints",
        finalizedEpoch ? `finalized epoch ${finalizedEpoch}` : "finality unavailable",
        6,
      ],
    ],
    finality: [
      ["latest", at(), "execution receipt exists", 5],
      ["justified", justifiedEpoch || "unknown", "current justified checkpoint from beacon API", 6],
      ["finalized", finalizedEpoch || "unknown", "finalized checkpoint from beacon API", 6],
    ],
  };
}

async function beaconGet(path) {
  try {
    const response = await fetch(`${beaconUrl.replace(/\/$/, "")}${path}`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function buildRecord(input) {
  const tx = input.tx || {};
  const receipt = input.receipt || {};
  const block = input.block || {};
  const effectiveGasPrice = receipt.effectiveGasPrice || tx.gasPrice || "-";
  const gasUsed = receipt.gasUsed || "-";
  const feeWei =
    isHex(gasUsed) && isHex(effectiveGasPrice)
      ? hexToBigInt(gasUsed) * hexToBigInt(effectiveGasPrice)
      : null;

  const txFields = [
    ["type", tx.type || "unknown", 0],
    ["chainId", `${input.chainId} / ${hexToDecimal(input.chainId)}`, 0],
    ["nonce", tx.nonce || input.beforeFromNonce || "unknown", 0],
    ["from", input.sender || input.fromCandidate || "unknown", 0],
    ["to", tx.to || to, 0],
    ["value", `${tx.value || hexQuantity(valueWei)} / ${valueWei.toString()} wei`, 0],
    ["input", tx.input || "0x", 0],
    ["gas", tx.gas || "unknown", 0],
    ["maxFeePerGas", tx.maxFeePerGas || "-", 0],
    ["maxPriorityFeePerGas", tx.maxPriorityFeePerGas || "-", 0],
  ];

  const preflight = [
    ["RPC_URL", rpcUrl, 0],
    ["BEACON_URL", beaconUrl || "not configured", 0],
    ["eth_chainId", `${input.chainId} / ${hexToDecimal(input.chainId)}`, 0],
    ["eth_blockNumber(before)", `${input.blockBefore} / ${hexToDecimal(input.blockBefore)}`, 0],
    ["eth_accounts", input.accounts.length ? input.accounts.join(", ") : "[]", 0],
    ["sender balance before", input.beforeFromBalance || "unknown", 0],
    ["recipient balance before", input.beforeToBalance || "unknown", 0],
  ];

  const signing = [
    ["send mode", input.sendResult.mode, 1],
    ["submit method", input.sendResult.method, 1],
    ["signing boundary", input.sendResult.detail, 1],
    ["private key handling", env.PRIVATE_KEY ? "PRIVATE_KEY was used but not written to output" : "no private key in script output", 1],
    ["transaction hash", input.txHash, 1],
  ];

  const rpcRows = [
    [input.sendResult.method, "submitted transaction to execution RPC", 2],
    ["eth_getTransactionByHash", tx.blockHash ? "included transaction returned" : "pending transaction returned", 2],
    ["eth_getTransactionReceipt", `status=${receipt.status || "unknown"}, block=${receipt.blockNumber || "unknown"}`, 5],
    ["eth_getBlockByHash", block.hash ? `timestamp=${block.timestamp}, txs=${block.transactions?.length ?? "unknown"}` : "block unavailable", 5],
  ];

  const builder = [
    ["execution RPC", at(), "eth_getBlockByHash", block.number ? `execution block ${hexToDecimal(block.number)}` : "block unavailable", 4],
    ...input.beaconRows.builder,
  ];

  const receiptRows = [
    ["blockNumber", receipt.blockNumber ? `${receipt.blockNumber} / ${hexToDecimal(receipt.blockNumber)}` : "unknown", 5],
    ["transactionIndex", receipt.transactionIndex || "unknown", 5],
    ["status", receipt.status || "unknown", 5],
    ["gasUsed", receipt.gasUsed ? `${receipt.gasUsed} / ${hexToDecimal(receipt.gasUsed)}` : "unknown", 5],
    ["effectiveGasPrice", effectiveGasPrice, 5],
    ["logs", Array.isArray(receipt.logs) ? `${receipt.logs.length}` : "unknown", 5],
  ];

  const diffs = [
    ["sender.balance", input.beforeFromBalance || "unknown", input.afterFromBalance || "unknown", feeWei ? `value + fee ~= ${valueWei + feeWei} wei` : "value + fee paid", 6],
    ["recipient.balance", input.beforeToBalance || "unknown", input.afterToBalance || "unknown", `${valueWei.toString()} wei received`, 6],
    ["sender.nonce", input.beforeFromNonce || tx.nonce || "unknown", input.afterFromNonce || "unknown", "transaction nonce consumed after inclusion", 6],
    ["block.stateRoot", "-", block.stateRoot || "unknown", "post-state root from execution block", 6],
  ];

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    source: "local-devnet",
    rpcUrl,
    beaconUrl: beaconUrl || null,
    txHash: input.txHash,
    sendMode: input.sendResult.mode,
    uiTx: {
      label: "Live",
      title: "Live Tx: local ETH transfer",
      subtitle: "A real transaction submitted to the configured local execution RPC.",
      type: "live-transfer",
      txHash: input.txHash,
      txFields,
      interface: [["activity", "native ETH transfer on local devnet", 0]],
      preflight,
      signing,
      rpc: rpcRows,
      txpool: input.txpoolBeforeReceipt,
      builder,
      receipt: receiptRows,
      trace: input.traceRows,
      diffs,
      finality: input.beaconRows.finality,
      record: {
        activityType: "live_transfer",
        source: "local-devnet",
        chainId: input.chainId,
        txHash: input.txHash,
        rpcUrl,
        beaconUrl: beaconUrl || null,
        sendMode: input.sendResult.mode,
        blockNumber: receipt.blockNumber || null,
        transactionIndex: receipt.transactionIndex || null,
        status: receipt.status || null,
        gasUsed: receipt.gasUsed || null,
        effectiveGasPrice,
        from: input.sender || input.fromCandidate || null,
        to,
        valueWei: valueWei.toString(),
        observedAt: new Date().toISOString(),
      },
    },
  };
}

function normalizeAddress(value, name) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte hex address, got ${value}`);
  }
  return value;
}

function normalizeOptionalAddress(value, name) {
  if (!value) return "";
  return normalizeAddress(value, name);
}

function parseWei(value) {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`VALUE_WEI must be a base-10 integer, got ${value}`);
  }
  return BigInt(value);
}

function hexQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function isHex(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
}

function hexToBigInt(value) {
  return BigInt(value);
}

function hexToDecimal(value) {
  if (!isHex(value)) return String(value || "unknown");
  return hexToBigInt(value).toString(10);
}

function parseTxHash(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.transactionHash === "string") return parsed.transactionHash;
    if (typeof parsed.hash === "string") return parsed.hash;
  } catch {
    // Fall back to text scanning for non-JSON cast output.
  }

  const labeledHash = text.match(/(?:transactionHash|txHash|hash)[^0-9a-fA-F]*(0x[a-fA-F0-9]{64})/);
  if (labeledHash?.[1]) return labeledHash[1];

  return text.match(/0x[a-fA-F0-9]{64}/)?.[0] || "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function short(value) {
  if (!value || typeof value !== "string") return "unknown";
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function at() {
  return `T+${((Date.now() - t0) / 1000).toFixed(2)}s`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
