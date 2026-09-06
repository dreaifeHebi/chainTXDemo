const KNOWN_CHAINS = {
  "0x7a69": { name: "Local Anvil", kind: "local" },
  "0x134b1da": { name: "Tx Flight Recorder PoS", kind: "local" },
  "0xaa36a7": { name: "Sepolia", kind: "testnet" },
  "0x88bb0": { name: "Hoodi", kind: "testnet" },
};

const EMPTY_RPC = {
  status: "idle",
  url: "http://127.0.0.1:8545",
  displayUrl: "127.0.0.1:8545",
  beaconUrl: "",
  chainId: "",
  chainName: "",
  clientVersion: "",
  blockNumber: "",
  beaconStatus: "idle",
  beaconHead: "",
  finalizedEpoch: "",
};

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function hexToDecimal(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return String(value || "unknown");
  return BigInt(value).toString(10);
}

function normalizeChainId(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`RPC returned invalid chainId: ${value}`);
  }
  return `0x${BigInt(value).toString(16)}`;
}

function displayRpcUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "invalid URL";
  }
}

function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

function isPrivateRpcUrl(value) {
  if (isLoopbackUrl(value)) return true;
  try {
    const host = new URL(value).hostname;
    // IPv6 unique-local addresses (including private mesh networks).
    if (/^\[f[cd][0-9a-f]{2}:/i.test(host)) return true;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  } catch {
    return false;
  }
}

function validateHttpUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${name} 必须是有效的 http(s) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} 只支持 http(s) URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} 不支持 URL 内嵌用户名或密码`);
  }
  return parsed.toString();
}

function normalizeAddress(value, name) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value || "")) {
    throw new Error(`${name} 必须是 20-byte 0x 地址`);
  }
  return value;
}

function normalizeData(value) {
  const data = value?.trim() || "0x";
  if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(data)) {
    throw new Error("calldata 必须是偶数长度的 0x hex bytes");
  }
  return data;
}

function parseEther(value) {
  const text = String(value || "").trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(text)) {
    throw new Error("ETH 数量必须是非负十进制数，最多 18 位小数");
  }
  const [whole, fraction = ""] = text.split(".");
  const wei = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0") || "0");
  return {
    decimal: wei.toString(10),
    hex: `0x${wei.toString(16)}`,
  };
}

function summarizeTxpool(content, nonce) {
  if (!content || typeof content !== "object") return null;
  const pending = content.pending || {};
  const queued = content.queued || {};
  const nonceDecimal = hexToDecimal(nonce);
  const pendingTx = pending[nonceDecimal] || pending[nonce] || null;
  const queuedTx = queued[nonceDecimal] || queued[nonce] || null;
  return {
    status: pendingTx ? "pending" : queuedTx ? "queued" : "not present",
    pendingCount: Object.keys(pending).length,
    queuedCount: Object.keys(queued).length,
    detail: `pending=${Object.keys(pending).length}, queued=${Object.keys(queued).length}`,
  };
}

function nowLabel(startedAt) {
  return `T+${((performance.now() - startedAt) / 1000).toFixed(2)}s`;
}

export function createInfraLab(onChange = () => {}) {
  let rpcId = 1;
  let walletListenersBound = false;
  const state = {
    open: false,
    busy: "",
    error: "",
    notice: "",
    rpc: { ...EMPTY_RPC },
    wallet: {
      status: typeof window !== "undefined" && window.ethereum ? "available" : "unavailable",
      account: "",
      chainId: "",
    },
    experiment: null,
  };

  function emit() {
    onChange(state);
  }

  function snapshot() {
    return state;
  }

  function setOpen(value) {
    state.open = Boolean(value);
    emit();
  }

  function clearMessage() {
    state.error = "";
    state.notice = "";
  }

  async function rpcRequest(method, params = []) {
    if (!state.rpc.url) throw new Error("请先连接 Execution RPC");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(state.rpc.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`${method} returned invalid JSON`);
      }
      if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
      if (payload.error) throw new Error(payload.error.message || `${method} failed`);
      return payload.result;
    } catch (error) {
      if (error.name === "AbortError") throw new Error(`${method} timed out`);
      if (error instanceof TypeError) {
        throw new Error(`${method} 无法读取 RPC 响应。请在浏览器所在电脑检查端口转发、RPC 的 OPTIONS/POST 跨域响应，以及 Console 中的混合内容或本地网络权限提示。`);
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function optionalRpc(method, params = []) {
    try {
      return await rpcRequest(method, params);
    } catch {
      return null;
    }
  }

  async function beaconGet(path) {
    if (!state.rpc.beaconUrl) return null;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${state.rpc.beaconUrl.replace(/\/$/, "")}${path}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function connectRpc({ rpcUrl, beaconUrl = "" }) {
    if (state.busy) return;
    clearMessage();
    state.busy = "rpc";
    state.rpc = { ...EMPTY_RPC, status: "connecting", url: rpcUrl.trim(), beaconUrl: beaconUrl.trim() };
    emit();

    try {
      // Validation must share the same error/finally path as the network request.
      state.rpc.url = validateHttpUrl(rpcUrl, "Execution RPC");
      state.rpc.displayUrl = displayRpcUrl(state.rpc.url);
      state.rpc.beaconUrl = beaconUrl.trim() ? validateHttpUrl(beaconUrl, "Beacon API") : "";
      const chainId = normalizeChainId(await rpcRequest("eth_chainId"));
      const [clientVersion, blockNumber] = await Promise.all([
        optionalRpc("web3_clientVersion"),
        rpcRequest("eth_blockNumber"),
      ]);
      state.rpc.chainId = chainId;
      state.rpc.chainName = KNOWN_CHAINS[chainId]?.name || `Custom chain ${hexToDecimal(chainId)}`;
      state.rpc.clientVersion = clientVersion || "web3_clientVersion unavailable";
      state.rpc.blockNumber = blockNumber;
      state.rpc.status = "connected";

      if (state.rpc.beaconUrl) {
        const [head, finality] = await Promise.all([
          beaconGet("/eth/v1/beacon/headers/head"),
          beaconGet("/eth/v1/beacon/states/head/finality_checkpoints"),
        ]);
        state.rpc.beaconHead = head?.data?.header?.message?.slot || "";
        state.rpc.finalizedEpoch = finality?.data?.finalized?.epoch || "";
        state.rpc.beaconStatus = head ? "connected" : "unavailable";
      } else {
        state.rpc.beaconStatus = "not-configured";
      }
      state.notice = `Execution RPC 已连接：${state.rpc.chainName}`;
    } catch (error) {
      state.rpc.status = "error";
      state.error = `RPC 连接失败：${error.message}`;
    } finally {
      state.busy = "";
      emit();
    }
  }

  function bindWalletListeners(provider) {
    if (walletListenersBound || !provider?.on) return;
    walletListenersBound = true;
    provider.on("accountsChanged", (accounts) => {
      state.wallet.account = accounts?.[0] || "";
      state.wallet.status = state.wallet.account ? "connected" : "available";
      emit();
    });
    provider.on("chainChanged", (chainId) => {
      state.wallet.chainId = normalizeChainId(chainId);
      emit();
    });
    provider.on("disconnect", () => {
      state.wallet.status = "disconnected";
      emit();
    });
  }

  async function connectWallet() {
    clearMessage();
    const provider = window.ethereum;
    if (!provider?.request) {
      state.wallet.status = "unavailable";
      state.error = "未检测到 EIP-1193 浏览器钱包。请安装钱包扩展后刷新页面。";
      emit();
      return;
    }
    state.busy = "wallet";
    emit();
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const chainId = await provider.request({ method: "eth_chainId" });
      state.wallet.account = accounts?.[0] || "";
      state.wallet.chainId = normalizeChainId(chainId);
      state.wallet.status = state.wallet.account ? "connected" : "available";
      bindWalletListeners(provider);
      state.notice = "钱包已连接；私钥始终保留在钱包中。";
    } catch (error) {
      state.error = error.code === 4001 ? "用户拒绝了钱包连接请求。" : `钱包连接失败：${error.message}`;
    } finally {
      state.busy = "";
      emit();
    }
  }

  async function switchWalletToRpc() {
    clearMessage();
    const provider = window.ethereum;
    if (!provider?.request || !state.rpc.chainId) {
      state.error = "请先连接钱包与 Execution RPC。";
      emit();
      return;
    }
    state.busy = "wallet";
    emit();
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: state.rpc.chainId }],
      });
      state.wallet.chainId = normalizeChainId(await provider.request({ method: "eth_chainId" }));
      state.notice = `钱包已切换到 ${state.rpc.chainName}`;
    } catch (error) {
      if (error.code === 4902) {
        try {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: state.rpc.chainId,
                chainName: state.rpc.chainName || "Custom test network",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: [state.rpc.url],
              },
            ],
          });
          state.wallet.chainId = normalizeChainId(await provider.request({ method: "eth_chainId" }));
          state.notice = `已请求钱包添加 ${state.rpc.chainName}`;
        } catch (addError) {
          state.error = `添加网络失败：${addError.message}`;
        }
      } else {
        state.error = error.code === 4001 ? "用户拒绝切换网络。" : `切换网络失败：${error.message}`;
      }
    } finally {
      state.busy = "";
      emit();
    }
  }

  function addExperimentEvent(experiment, stage, action, result, source = "observed") {
    experiment.events.push({
      stage,
      at: nowLabel(experiment.startedAt),
      action,
      result,
      source,
    });
    experiment.stage = Math.max(experiment.stage, stage);
    emit();
  }

  function validateExperimentChain() {
    const chain = KNOWN_CHAINS[state.rpc.chainId];
    if (chain?.kind === "testnet") return;
    if (chain?.kind === "local" && isPrivateRpcUrl(state.rpc.url)) return;
    throw new Error("实验发送支持本机或私有网络上的 Anvil（31337）/开发网（20230618），以及 Sepolia、Hoodi。当前 chainId=" + hexToDecimal(state.rpc.chainId) + "，请确认 RPC 和钱包连接的是测试链。");
  }

  async function observeFinality(experiment) {
    const target = experiment.receipt?.blockNumber;
    if (!target) return;
    const targetNumber = BigInt(target);
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (state.experiment !== experiment) return;
      const [safeBlock, finalizedBlock] = await Promise.all([
        optionalRpc("eth_getBlockByNumber", ["safe", false]),
        optionalRpc("eth_getBlockByNumber", ["finalized", false]),
      ]);
      const safeReached = safeBlock?.number && BigInt(safeBlock.number) >= targetNumber;
      const finalizedReached = finalizedBlock?.number && BigInt(finalizedBlock.number) >= targetNumber;
      if (safeReached && !experiment.safeAt) {
        experiment.safeAt = nowLabel(experiment.startedAt);
        experiment.status = "safe";
        addExperimentEvent(experiment, 7, "safe block reached", `safe=${safeBlock.number}`);
      }
      if (finalizedReached && !experiment.finalizedAt) {
        experiment.finalizedAt = nowLabel(experiment.startedAt);
        experiment.status = "finalized";
        addExperimentEvent(experiment, 7, "finalized block reached", `finalized=${finalizedBlock.number}`);
        return;
      }
      await sleep(5000);
    }
  }

  async function observeTransaction(experiment) {
    try {
      const txpool = await optionalRpc("txpool_contentFrom", [experiment.from]);
      if (txpool) {
        experiment.txpool = summarizeTxpool(txpool, experiment.preflight.nonce);
        addExperimentEvent(
          experiment,
          4,
          "txpool_contentFrom",
          experiment.txpool?.detail || "txpool response received",
        );
      } else {
        experiment.txpool = { status: "unavailable", detail: "txpool namespace unavailable" };
        addExperimentEvent(experiment, 4, "txpool_contentFrom", "method unavailable", "missing");
      }

      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        if (state.experiment !== experiment) return;
        const [tx, receipt] = await Promise.all([
          optionalRpc("eth_getTransactionByHash", [experiment.txHash]),
          optionalRpc("eth_getTransactionReceipt", [experiment.txHash]),
        ]);
        if (tx && !experiment.tx) {
          experiment.tx = tx;
          experiment.status = tx.blockHash ? "included" : "pending";
          addExperimentEvent(
            experiment,
            tx.blockHash ? 5 : 4,
            "eth_getTransactionByHash",
            tx.blockHash ? `included in ${tx.blockNumber}` : "visible as pending",
          );
        }
        if (receipt) {
          experiment.receipt = receipt;
          experiment.status = "included";
          state.rpc.blockNumber = receipt.blockNumber;
          experiment.block = receipt.blockHash
            ? await optionalRpc("eth_getBlockByHash", [receipt.blockHash, false])
            : null;
          experiment.trace = await optionalRpc("debug_traceTransaction", [experiment.txHash, { tracer: "callTracer" }]);
          experiment.afterFromBalance = await optionalRpc("eth_getBalance", [experiment.from, "latest"]);
          experiment.afterToBalance = await optionalRpc("eth_getBalance", [experiment.to, "latest"]);
          addExperimentEvent(
            experiment,
            6,
            "eth_getTransactionReceipt",
            `status=${receipt.status}, block=${receipt.blockNumber}`,
          );
          addExperimentEvent(experiment, 7, "latest block contains transaction", receipt.blockHash || "block hash unavailable");
          if (experiment.chainId !== "0x7a69") {
            observeFinality(experiment).catch(() => {});
          }
          return;
        }
        await sleep(1000);
      }
      throw new Error("等待 receipt 超时（180s）");
    } catch (error) {
      experiment.status = "error";
      experiment.error = error.message;
      state.error = `交易观察失败：${error.message}`;
      emit();
    }
  }

  async function sendExperiment({ to, valueEth, data }) {
    clearMessage();
    const provider = window.ethereum;
    try {
      if (state.rpc.status !== "connected") throw new Error("请先连接 Execution RPC");
      if (state.wallet.status !== "connected" || !provider?.request) throw new Error("请先连接浏览器钱包");
      if (state.wallet.chainId !== state.rpc.chainId) throw new Error("钱包 chainId 与 Execution RPC 不一致");
      validateExperimentChain();
      const recipient = normalizeAddress(to, "to");
      const value = parseEther(valueEth);
      const calldata = normalizeData(data);
      const startedAt = performance.now();
      const experiment = {
        status: "preparing",
        stage: 0,
        startedAt,
        events: [],
        chainId: state.rpc.chainId,
        rpcDisplayUrl: state.rpc.displayUrl,
        from: state.wallet.account,
        to: recipient,
        valueEth: String(valueEth),
        valueWei: value.decimal,
        valueHex: value.hex,
        data: calldata,
        preflight: {},
        txHash: "",
        tx: null,
        receipt: null,
        block: null,
        txpool: null,
        trace: null,
        safeAt: "",
        finalizedAt: "",
        error: "",
      };
      state.experiment = experiment;
      state.busy = "transaction";
      addExperimentEvent(experiment, 0, "Web form submitted", `to=${recipient}, value=${value.decimal} wei`);

      const transaction = {
        from: experiment.from,
        to: recipient,
        value: value.hex,
        data: calldata,
      };
      const [nonce, gas, beforeFromBalance, beforeToBalance] = await Promise.all([
        rpcRequest("eth_getTransactionCount", [experiment.from, "pending"]),
        rpcRequest("eth_estimateGas", [transaction]),
        optionalRpc("eth_getBalance", [experiment.from, "latest"]),
        optionalRpc("eth_getBalance", [recipient, "latest"]),
      ]);
      const priorityFee = await optionalRpc("eth_maxPriorityFeePerGas");
      experiment.preflight = {
        nonce,
        gas,
        priorityFee,
        beforeFromBalance,
        beforeToBalance,
      };
      experiment.beforeFromBalance = beforeFromBalance;
      experiment.beforeToBalance = beforeToBalance;
      transaction.gas = gas;
      addExperimentEvent(experiment, 1, "RPC preflight completed", `nonce=${nonce}, gas=${gas}`);
      addExperimentEvent(experiment, 2, "Wallet confirmation requested", "awaiting user approval");

      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [transaction],
      });
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash || "")) throw new Error("wallet returned invalid txHash");
      experiment.txHash = txHash;
      experiment.status = "broadcast";
      addExperimentEvent(experiment, 3, "wallet returned txHash", txHash);
      state.notice = "交易已由钱包提交；正在通过选定 RPC 观察节点与上链状态。";
      state.busy = "";
      emit();
      observeTransaction(experiment).catch(() => {});
    } catch (error) {
      state.busy = "";
      state.error = error.code === 4001 ? "用户在钱包中拒绝了交易。" : `实验交易失败：${error.message}`;
      if (state.experiment) {
        state.experiment.status = "error";
        state.experiment.error = state.error;
      }
      emit();
    }
  }

  return {
    snapshot,
    setOpen,
    connectRpc,
    connectWallet,
    switchWalletToRpc,
    sendExperiment,
  };
}

export { KNOWN_CHAINS, hexToDecimal };
