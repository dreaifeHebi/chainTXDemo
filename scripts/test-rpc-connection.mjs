import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../src/infra-lab.js", import.meta.url), "utf8");
const { createInfraLab } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("RPC validation failures release the UI and allow a subsequent HTTP connection", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.fetch = async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ url, ...request });
    const result = { eth_chainId: "0x7a69", eth_blockNumber: "0x3", web3_clientVersion: "test-client" }[request.method];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  };
  try {
    const changes = [];
    const lab = createInfraLab((state) => changes.push(structuredClone(state)));
    for (const rpcUrl of ["bad-url", "ws://localhost:8545", "https://user:password@example.com"]) {
      await lab.connectRpc({ rpcUrl });
      assert.equal(lab.snapshot().busy, "");
      assert.equal(lab.snapshot().rpc.status, "error");
      assert.ok(lab.snapshot().error);
      assert.equal(requests.length, 0);
      assert.equal(changes.at(-1).rpc.status, "error");
    }
    await lab.connectRpc({ rpcUrl: "http://192.168.1.12:8545/rpc/" });
    assert.equal(lab.snapshot().rpc.status, "connected");
    assert.equal(lab.snapshot().error, "");
    assert.equal(requests[0].url, "http://192.168.1.12:8545/rpc/");
    assert.equal(requests[0].method, "eth_chainId");

    requests.length = 0;
    await lab.connectRpc({ rpcUrl: "http://localhost:18545", beaconUrl: "bad-beacon" });
    assert.equal(lab.snapshot().busy, "");
    assert.equal(lab.snapshot().rpc.chainId, "");
    assert.match(lab.snapshot().error, /Beacon API/);
    assert.equal(requests.length, 0);

    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await lab.connectRpc({ rpcUrl: "http://localhost:18545" });
    assert.equal(lab.snapshot().busy, "");
    assert.match(lab.snapshot().error, /端口转发/);
    assert.equal(lab.snapshot().rpc.status, "error");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});

test("send policy permits private development RPCs and rejects mainnet even through loopback", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const cases = [
    ["http://192.168.1.5:8545", "0x7a69", true],
    ["http://127.0.0.1:18545", "0x7a69", true],
    ["http://10.0.0.5:8545", "0x134b1da", true],
    ["http://172.16.0.5:8545", "0x7a69", true],
    ["http://100.92.194.31:8545", "0x7a69", true],
    ["http://[fd00::5]:8545", "0x7a69", true],
    ["https://rpc.example.org", "0xaa36a7", true],
    ["https://rpc.example.org", "0x88bb0", true],
    ["http://127.0.0.1:8545", "0x1", false],
    ["http://192.168.1.5:8545", "0x1", false],
    ["http://192.168.1.5:8545", "0x1234", false],
    ["http://172.32.0.5:8545", "0x7a69", false],
    ["https://rpc.example.org", "0x7a69", false],
    ["http://192.168.1.5.example.org:8545", "0x7a69", false],
  ];
  try {
    for (const [rpcUrl, chainId, allowed] of cases) {
      const account = "0x0000000000000000000000000000000000000001";
      let sendCalls = 0;
      const methods = [];
      globalThis.window = { setTimeout, clearTimeout, ethereum: {
        on() {},
        async request({ method }) {
          if (method === "eth_requestAccounts") return [account];
          if (method === "eth_chainId") return chainId;
          if (method === "eth_sendTransaction") {
            sendCalls++;
            // Stop at the wallet boundary: tests never broadcast a transaction.
            throw Object.assign(new Error("user rejected"), { code: 4001 });
          }
          throw new Error(`Unexpected wallet method: ${method}`);
        },
      } };
      globalThis.fetch = async (url, options) => {
        const request = JSON.parse(options.body);
        methods.push(request.method);
        const result = {
          eth_chainId: chainId, eth_blockNumber: "0x1", web3_clientVersion: "test-client",
          eth_getTransactionCount: "0x0", eth_estimateGas: "0x5208",
          eth_getBalance: "0xde0b6b3a7640000", eth_maxPriorityFeePerGas: "0x1",
        }[request.method];
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      };
      const lab = createInfraLab();
      await lab.connectRpc({ rpcUrl });
      await lab.connectWallet();
      await lab.sendExperiment({ to: account, valueEth: "0.001", data: "0x" });
      assert.equal(sendCalls, allowed ? 1 : 0, `${rpcUrl}, ${chainId}`);
      assert.equal(methods.includes("eth_estimateGas"), allowed);
      assert.match(lab.snapshot().error, allowed ? /用户在钱包中拒绝/ : /当前 chainId=/);
      assert.equal(lab.snapshot().busy, "");
    }
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});
