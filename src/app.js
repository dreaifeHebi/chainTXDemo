import { createInfraLab, hexToDecimal } from "./infra-lab.js";

const FLOW_STEPS = [
  {
    id: "intent",
    label: "Web 决定发起",
    detail: "用户操作变成交易意图",
    actor: "Web / DApp",
    from: "用户操作",
    to: "交易请求",
    input: "页面上的业务操作",
    action: "决定接收方、金额或合约方法参数",
    output: "尚未签名的交易意图",
    summary: "Web 只是在表达“想做什么”。这时还没有签名、txHash、txpool 记录，也没有任何链上状态变化。",
  },
  {
    id: "construct",
    label: "构造交易",
    detail: "补齐 nonce、gas、fee、calldata",
    actor: "Web + RPC（只读）",
    from: "交易意图",
    to: "Unsigned Tx",
    input: "to / value / 方法参数",
    action: "查询链信息并编码交易字段",
    output: "可以交给钱包签名的交易对象",
    summary: "应用会读取 chainId、pending nonce、费用和 gas 估算，再把业务参数编码成一份未签名交易。预检查 RPC 不会修改链上状态。",
  },
  {
    id: "sign",
    label: "钱包签名",
    detail: "授权并生成 raw transaction",
    actor: "Wallet / Signer",
    from: "Unsigned Tx",
    to: "Raw Tx + txHash",
    input: "完整的未签名交易字段",
    action: "用私钥签交易摘要并序列化",
    output: "可广播的 raw tx 与交易哈希",
    summary: "签名证明账户授权了这组字段。签名仍发生在链外；只签名但不广播，不会消耗 nonce 或 gas。",
  },
  {
    id: "rpc",
    label: "RPC 提交",
    detail: "把 raw tx 交给执行节点",
    actor: "RPC Gateway",
    from: "钱包 / Web",
    to: "Execution Node A",
    input: "已签名的 raw transaction",
    action: "调用 eth_sendRawTransaction 并转交节点",
    output: "txHash 或明确的 RPC 拒绝错误",
    summary: "RPC 是入口，不是共识者。返回 txHash 只代表这台节点接受了提交请求，不代表交易已经入块或执行成功。",
  },
  {
    id: "node",
    label: "节点接收处理",
    detail: "校验、入池、P2P 传播",
    actor: "Execution Node / Geth",
    from: "RPC 边界",
    to: "Txpool + EL P2P",
    input: "节点收到的 raw transaction",
    action: "检查签名、nonce、余额、gas 与本地策略",
    output: "pending / queued / rejected",
    summary: "通过检查的交易进入这台节点自己的 txpool，并通过执行层 P2P 传播给其他节点。全网不存在一个统一的 txpool。",
  },
  {
    id: "payload",
    label: "打包进区块",
    detail: "EL 构建 payload，validator 签块",
    actor: "EL + CL + Validator",
    from: "Txpool",
    to: "Beacon Block",
    input: "当前 head 与本地待处理交易",
    action: "选择交易、执行候选 payload、签署区块",
    output: "包含 execution payload 的 Beacon Block",
    summary: "当前 slot 的 proposer 触发出块。Consensus Client 通过 Engine API 让 Execution Client 构建 payload，Validator Client 最后签署区块。",
  },
  {
    id: "execute",
    label: "EVM 执行",
    detail: "所有节点重放并验证结果",
    actor: "Execution Clients",
    from: "Proposed Block",
    to: "Receipt + State Root",
    input: "区块中的 execution payload",
    action: "逐笔重执行交易并检查状态根",
    output: "receipt、status、gas、logs、trace",
    summary: "真正运行合约代码的是 Execution Client。其他节点会重放相同交易；结果不一致时，这个区块就是无效的。",
  },
  {
    id: "chain",
    label: "上链与确认",
    detail: "状态落入区块并走向 finality",
    actor: "Chain / Consensus",
    from: "Valid Block",
    to: "Latest → Safe → Finalized",
    input: "有效区块与 validators 的 attestations",
    action: "更新 canonical head、safe 与 finalized checkpoint",
    output: "持久状态变化与确认级别",
    summary: "receipt 出现表示交易已进入某个区块；随后还要经历 safe 和 finalized。最终性属于区块，交易随所在区块一起最终确定。",
  },
];

const ADDRESSES = {
  alice: "0xa11CE00000000000000000000000000000000004",
  bob: "0xb0B0000000000000000000000000000000000005",
  counter: "0xC0de000000000000000000000000000000000006",
  relayer: "0x7e1a000000000000000000000000000000000007",
};

const TX_TYPES = {
  0: {
    tab: "Type 0",
    name: "Legacy",
    badge: "RLP list",
    typeValue: "legacy / no EIP-2718 type byte",
    envelope: "rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])",
    wirePrefix: "first byte is an RLP list marker, usually >= 0xc0",
    feeModel: "single gasPrice; no base-fee cap and no access list",
    feeRows: [["gasPrice", "0x6fc23ac0 / 1.875 gwei", 0]],
    extraRows: [],
    signing: "keccak256(rlp([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]))",
    signature: "v, r, s",
    rawPrefix: "0xf8... / no leading transaction type byte",
    chainNote: "Works for transfer, contract creation, and contract calls.",
  },
  1: {
    tab: "Type 1",
    name: "Access List",
    badge: "0x01",
    typeValue: "0x01 / EIP-2930",
    envelope: "0x01 || rlp([chainId, nonce, gasPrice, gasLimit, to, value, data, accessList, yParity, r, s])",
    wirePrefix: "0x01 followed by an RLP payload",
    feeModel: "single gasPrice plus predeclared accessList",
    feeRows: [["gasPrice", "0x6fc23ac0 / 1.875 gwei", 0]],
    extraRows: [["accessList", "[[Counter, [slot0]]] for contract call, [] otherwise", 0]],
    signing: "keccak256(0x01 || rlp([chainId, nonce, gasPrice, gasLimit, to, value, data, accessList]))",
    signature: "yParity, r, s",
    rawPrefix: "0x01f8...",
    chainNote: "Same execution semantics as legacy, but warms listed accounts and storage keys.",
  },
  2: {
    tab: "Type 2",
    name: "EIP-1559",
    badge: "0x02",
    typeValue: "0x02 / EIP-1559",
    envelope: "0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, yParity, r, s])",
    wirePrefix: "0x02 followed by an RLP payload",
    feeModel: "base fee is burned; sender caps total and priority fee",
    feeRows: [
      ["maxFeePerGas", "0x77359400 / 2 gwei", 0],
      ["maxPriorityFeePerGas", "0x3b9aca00 / 1 gwei", 0],
    ],
    extraRows: [["accessList", "[] in the baseline demo", 0]],
    signing: "keccak256(0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList]))",
    signature: "yParity, r, s",
    rawPrefix: "0x02f8...",
    chainNote: "Best baseline for comparing transfer, deploy, call, and revert on a modern chain.",
  },
  3: {
    tab: "Type 3",
    name: "Blob",
    badge: "0x03",
    typeValue: "0x03 / EIP-4844",
    envelope: "0x03 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, maxFeePerBlobGas, blobVersionedHashes, yParity, r, s])",
    wirePrefix: "0x03 followed by an RLP payload; pooled gossip wraps blobs, commitments, and proofs",
    feeModel: "EIP-1559 gas fee plus independent blob gas fee",
    feeRows: [
      ["maxFeePerGas", "0x77359400 / 2 gwei", 0],
      ["maxPriorityFeePerGas", "0x3b9aca00 / 1 gwei", 0],
      ["maxFeePerBlobGas", "0x3b9aca00 / 1 gwei", 0],
    ],
    extraRows: [
      ["blobVersionedHashes", "[0x01f3...cafe] / at least one blob hash", 0],
      ["sidecar", "blob + KZG commitment + KZG proof travel with CL data availability", 0],
    ],
    signing: "keccak256(0x03 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, maxFeePerBlobGas, blobVersionedHashes]))",
    signature: "yParity, r, s",
    rawPrefix: "0x03f9...",
    chainNote: "Cannot be contract creation because to must be a 20-byte address.",
  },
  4: {
    tab: "Type 4",
    name: "Set Code",
    badge: "0x04",
    typeValue: "0x04 / EIP-7702",
    envelope: "0x04 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, destination, value, data, accessList, authorizationList, yParity, r, s])",
    wirePrefix: "0x04 followed by an RLP payload",
    feeModel: "EIP-1559 gas fee plus per-authorization validation costs",
    feeRows: [
      ["maxFeePerGas", "0x77359400 / 2 gwei", 0],
      ["maxPriorityFeePerGas", "0x3b9aca00 / 1 gwei", 0],
    ],
    extraRows: [
      ["authorizationList", "[[chainId, delegateAddress, nonce, yParity, r, s]]", 0],
      ["delegation", "authority code becomes 0xef0100 || delegateAddress", 0],
    ],
    signing: "keccak256(0x04 || rlp(payload with authorizationList))",
    signature: "yParity, r, s",
    rawPrefix: "0x04f9...",
    chainNote: "Destination cannot be null, and authorizationList must not be empty.",
  },
};

const TXS = {
  transfer: {
    label: "Transfer",
    title: "Tx 1: Native ETH transfer",
    subtitle: "EOA to EOA, value moves, calldata stays empty",
    type: "transfer",
    txHash: "0xf4f0c91d8b20c4c9a789bb6cbe9782666df64d3df3268c5d840b42dd77c71201",
    txFields: [
      ["type", "0x02 / EIP-1559", 0],
      ["chainId", "0x7e7 / local PoS devnet", 0],
      ["nonce", "0x04", 0],
      ["from", ADDRESSES.alice, 0],
      ["to", ADDRESSES.bob, 0],
      ["value", "0xde0b6b3a7640000 / 1 ETH", 0],
      ["input", "0x", 0],
      ["gas", "0x5208 / 21,000", 0],
      ["maxFeePerGas", "0x77359400 / 2 gwei", 0],
      ["maxPriorityFeePerGas", "0x3b9aca00 / 1 gwei", 0],
    ],
    preflight: [
      ["eth_chainId", "0x7e7", 0],
      ["eth_getTransactionCount(pending)", "0x04", 0],
      ["eth_feeHistory", "baseFee 0.82 -> 0.91 gwei", 0],
      ["eth_maxPriorityFeePerGas", "1 gwei", 0],
      ["eth_estimateGas", "0x5208", 0],
    ],
    signing: [
      ["unsigned tx", "02 f8 72 82 07 e7 04 ...", 1],
      ["signing hash", "0x21ee0a4c49c418d58f0ef0f32d6bc4779d4eb0526f3f9c1dbf0bb28e7ab8f552", 1],
      ["yParity", "0x01", 1],
      ["r", "0x9c3d0cbfe57a4fb71a1fa90a7a4b2c938a1dff09896428f37c2d934af52c4fd5", 1],
      ["s", "0x35d78a4999f3e75df74667482fc088e92bf1a9a5db82f5deaa0f7eb8b606df38", 1],
      ["raw tx", "0x02f8758207e704843b9aca00847735940082520894b0b0...c0", 1],
    ],
    rpc: [
      ["eth_sendRawTransaction", "returns txHash only; blockHash is still null", 2],
      ["eth_getTransactionByHash", "pending tx: blockNumber null", 2],
    ],
    txpool: [
      ["Node A / geth-0", "T+0.22s", "pending", "nonce 4", "accepted by RPC", 3],
      ["Node B / geth-1", "T+0.86s", "pending", "nonce 4", "seen over EL P2P", 3],
    ],
    builder: [
      ["T+3.9s", "lighthouse-0", "engine_forkchoiceUpdated", "CL asks EL to prepare a payload for slot 182", 4],
      ["T+4.1s", "geth-0", "engine_getPayload", "payload includes tx index 0", 4],
      ["T+4.3s", "validator-0", "Beacon block proposed", "slot 182, proposer index 8", 4],
      ["T+4.7s", "geth-1", "engine_newPayload", "Node B re-executes and validates the block", 4],
    ],
    receipt: [
      ["blockNumber", "0xb6 / 182", 5],
      ["transactionIndex", "0x0", 5],
      ["status", "0x1", 5],
      ["gasUsed", "0x5208 / 21,000", 5],
      ["effectiveGasPrice", "0x6fc23ac0 / 1.875 gwei", 5],
      ["logs", "[]", 5],
    ],
    trace: [
      ["Intrinsic", "21,000", "validate nonce, balance, fee cap", 5],
      ["CALLVALUE", "2", "value transferred to Bob", 5],
      ["STOP", "0", "no contract code executed", 5],
    ],
    diffs: [
      ["Alice.nonce", "4", "5", "nonce consumed", 6],
      ["Alice.balance", "100.0000 ETH", "98.999960625 ETH", "value + gas paid", 6],
      ["Bob.balance", "0 ETH", "1 ETH", "native balance update", 6],
      ["Block.stateRoot", "0x5b82...ef19", "0x17ad...4fd0", "post-state committed", 6],
    ],
    finality: [
      ["latest", "T+4.8s", "receipt exists", 5],
      ["safe", "T+16.2s", "safe head contains block 182", 6],
      ["finalized", "T+64.4s", "finalized checkpoint >= slot 182", 6],
    ],
    record: {
      txHash: "0xf4f0c91d8b20c4c9a789bb6cbe9782666df64d3df3268c5d840b42dd77c71201",
      activityType: "transfer",
      rpcAcceptedAt: "T+0.22s",
      firstSeenByNodeA: "T+0.22s",
      firstSeenByNodeB: "T+0.86s",
      includedSlot: 182,
      proposerIndex: 8,
      blockHash: "0x8db5d6c9f60b2ac9bdf9fbd1a7459cb63eea2b78d932536ae0c09ce4e0fb7ad0",
      transactionIndex: 0,
      status: 1,
      gasUsed: "21000",
      stateDiff: {
        "Alice.nonce": "4 -> 5",
        "Alice.balance": "-1 ETH - fee",
        "Bob.balance": "+1 ETH",
      },
      safeAt: "T+16.2s",
      finalizedAt: "T+64.4s",
    },
  },
  deploy: {
    label: "Deploy",
    title: "Tx 2: Deploy CounterVault",
    subtitle: "contract creation produces the code used by ABI calls, receive(), and EIP-712 relay calls",
    type: "deploy",
    txHash: "0x86fffc245f5ab8385b83c37013130fb8fd059fb95f7c5e0eb9e7e2237396c7dd",
    txFields: [
      ["type", "0x02 / EIP-1559", 0],
      ["chainId", "0x7e7 / local PoS devnet", 0],
      ["nonce", "0x05", 0],
      ["from", ADDRESSES.alice, 0],
      ["to", "null / contract creation", 0],
      ["value", "0x0", 0],
      ["input", "0x6080604052348015600e575f80fd5b506101c8...", 0],
      ["gas", "0x02cc86 / 183,430", 0],
      ["maxFeePerGas", "0x77359400 / 2 gwei", 0],
      ["maxPriorityFeePerGas", "0x3b9aca00 / 1 gwei", 0],
    ],
    interface: [
      ["contract", "CounterVault", 0],
      ["storage", "uint256 value; mapping(address => uint256) eip712Nonces", 0],
      ["ABI method", "increase(uint256 amount)", 0],
      ["ABI method", "executeIncreaseWithSig(address owner,uint256 amount,uint256 deadline,uint8 v,bytes32 r,bytes32 s)", 0],
      ["receive", "receive() external payable emits Deposit(sender, amount)", 0],
      ["failure path", "alwaysFail() reverts with demo revert", 0],
    ],
    preflight: [
      ["eth_chainId", "0x7e7", 0],
      ["eth_getTransactionCount(pending)", "0x05", 0],
      ["eth_feeHistory", "baseFee 0.91 -> 0.96 gwei", 0],
      ["eth_estimateGas", "0x02cc86", 0],
      ["eth_getCode(predicted)", "0x", 0],
    ],
    signing: [
      ["unsigned tx", "02 f9 02 82 07 e7 05 ... initcode", 1],
      ["signing hash", "0x40b19a9d6e0fb58d9f31cb83f43de54159a3814ecb69d8b7e9a65d3ddf89bbbe", 1],
      ["yParity", "0x00", 1],
      ["r", "0x7f14edc892cdf1c7fe81bb460e9c2bd7a31ae5de6fb3809c7f7012417c5648c0", 1],
      ["s", "0x4dbafc69cc7248ad9efcf98c0b5e65333224a629d607e5598e7169280ef81ed9", 1],
      ["raw tx", "0x02f902158207e705843b9aca0084773594008302cc8680b901c8...", 1],
    ],
    rpc: [
      ["eth_sendRawTransaction", "tx accepted by Node A", 2],
      ["eth_getTransactionByHash", "to null, input contains init code", 2],
    ],
    txpool: [
      ["Node A / geth-0", "T+0.18s", "pending", "nonce 5", "creation tx accepted", 3],
      ["Node B / geth-1", "T+0.71s", "pending", "nonce 5", "propagated over EL P2P", 3],
    ],
    builder: [
      ["T+3.9s", "lighthouse-1", "engine_forkchoiceUpdated", "prepare slot 183 payload", 4],
      ["T+4.0s", "geth-1", "engine_getPayload", "payload includes contract creation", 4],
      ["T+4.2s", "validator-1", "Beacon block proposed", "slot 183, proposer index 19", 4],
      ["T+4.6s", "geth-0", "engine_newPayload", "Node A replays init code and checks state root", 4],
    ],
    receipt: [
      ["blockNumber", "0xb7 / 183", 5],
      ["transactionIndex", "0x0", 5],
      ["status", "0x1", 5],
      ["gasUsed", "0x02b49e / 177,310", 5],
      ["contractAddress", ADDRESSES.counter, 5],
      ["logs", "[]", 5],
    ],
    trace: [
      ["CREATE", "32,000", "new account initialized", 5],
      ["CODECOPY", "684", "runtime bytecode copied from init code", 5],
      ["RETURN", "0", "init code returns runtime bytecode", 5],
    ],
    diffs: [
      ["Alice.nonce", "5", "6", "nonce consumed", 6],
      ["Counter.code", "0x", "0x6080604052...081f", "runtime bytecode stored", 6],
      ["Counter.slot0", "0x0", "0x0", "constructor leaves value at zero", 6],
      ["Block.stateRoot", "0x17ad...4fd0", "0x9d82...114a", "account trie updated", 6],
    ],
    finality: [
      ["latest", "T+4.6s", "receipt has contractAddress", 5],
      ["safe", "T+17.0s", "safe head contains slot 183", 6],
      ["finalized", "T+68.1s", "checkpoint finalizes slot 183", 6],
    ],
    record: {
      txHash: "0x86fffc245f5ab8385b83c37013130fb8fd059fb95f7c5e0eb9e7e2237396c7dd",
      activityType: "deploy",
      rpcAcceptedAt: "T+0.18s",
      firstSeenByNodeA: "T+0.18s",
      firstSeenByNodeB: "T+0.71s",
      includedSlot: 183,
      proposerIndex: 19,
      blockHash: "0x9199f6b066c3d03dccb864ba889b45760a83af2fc831337d03fbb01ed803b571",
      transactionIndex: 0,
      status: 1,
      gasUsed: "177310",
      contractAddress: "0xC0de000000000000000000000000000000000006",
      stateDiff: {
        "Counter.code": "0x -> 0x6080604052...",
        "Counter.slot0": "0 -> 0",
      },
      safeAt: "T+17.0s",
      finalizedAt: "T+68.1s",
    },
  },
  call: {
    label: "ABI call",
    title: "Tx 3: ABI call increase(7)",
    subtitle: "direct contract call: function selector plus ABI-encoded uint256 changes storage slot 0",
    type: "call",
    txHash: "0x51f82c50e4515cf4b72e3d12fb1b0760ac4ccb468a10e574a7ee3968d911238e",
    txFields: [
      ["type", "0x02 / EIP-1559", 0],
      ["chainId", "0x7e7 / local PoS devnet", 0],
      ["nonce", "0x06", 0],
      ["from", ADDRESSES.alice, 0],
      ["to", ADDRESSES.counter, 0],
      ["value", "0x0", 0],
      ["input", "0x30f3f0db0000000000000000000000000000000000000000000000000000000000000007", 0],
      ["selector", "0x30f3f0db / increase(uint256)", 0],
      ["gas", "0x0b431 / 46,129", 0],
      ["maxFeePerGas", "0x77359400 / 2 gwei", 0],
    ],
    interface: [
      ["DApp button", "Increase by 7", 0],
      ["contract method", "increase(uint256 amount)", 0],
      ["wallet action", "signs an on-chain transaction, not typed data", 1],
      ["sender pays", "Alice pays gas and consumes Alice account nonce", 6],
    ],
    abi: [
      ["function signature", "increase(uint256)", 0],
      ["selector", "keccak256(signature)[0:4] = 0x30f3f0db", 0],
      ["argument word", "uint256(7) = 0x0000000000000000000000000000000000000000000000000000000000000007", 0],
      ["calldata", "0x30f3f0db + 32-byte amount", 0],
      ["EVM effect", "SLOAD slot0, ADD, SSTORE slot0, LOG Increased(0,7)", 5],
    ],
    preflight: [
      ["eth_call", "returns 0x without state mutation", 0],
      ["eth_estimateGas", "0x0b431", 0],
      ["eth_getStorageAt(slot 0)", "0x0", 0],
      ["eth_getTransactionCount(pending)", "0x06", 0],
    ],
    signing: [
      ["unsigned tx", "02 f8 94 82 07 e7 06 ... 30f3f0db...", 1],
      ["signing hash", "0xa47244d7bf14013bd7e9ac02ffab12e33ee3e5d7c7f271fcf5238349958df12a", 1],
      ["yParity", "0x01", 1],
      ["r", "0x5c8e46e3c09e6384f5e68aa04f1fbd72635619089ba9467e7a9075439077be22", 1],
      ["s", "0x2a33e994fd73f2f4d4c6a997bb86929201110fd75508173cecb3a604c5c781d1", 1],
      ["raw tx", "0x02f8978207e706843b9aca00847735940082b43194c0de...", 1],
    ],
    rpc: [
      ["eth_sendRawTransaction", "broadcast signed bytes", 2],
      ["eth_getTransactionByHash", "pending tx has selector 0x30f3f0db", 2],
    ],
    txpool: [
      ["Node A / geth-0", "T+0.25s", "pending", "nonce 6", "accepted by RPC", 3],
      ["Node B / geth-1", "T+0.80s", "pending", "nonce 6", "propagated over EL P2P", 3],
    ],
    builder: [
      ["T+3.8s", "lighthouse-0", "engine_forkchoiceUpdated", "new head, build next payload", 4],
      ["T+4.0s", "geth-0", "engine_getPayload", "payload includes tx index 1", 4],
      ["T+4.1s", "validator-0", "Beacon block proposed", "slot 184, proposer index 8", 4],
      ["T+4.5s", "geth-1", "engine_newPayload", "re-executes SSTORE and log emission", 4],
    ],
    receipt: [
      ["blockNumber", "0xb8 / 184", 5],
      ["transactionIndex", "0x1", 5],
      ["status", "0x1", 5],
      ["gasUsed", "0xa1f1 / 41,457", 5],
      ["logs[0].topics[0]", "0x30845c3e9107632fad0d79850bbf4bad84d533879c7068c957ca3851510d5281", 5],
      ["logs[0].data", "oldValue=0, newValue=7", 5],
    ],
    trace: [
      ["CALLDATALOAD", "3", "read amount=7", 5],
      ["SLOAD", "2,100", "load slot0 value=0", 5],
      ["ADD", "3", "0 + 7", 5],
      ["SSTORE", "20,000", "slot0 becomes 7", 5],
      ["LOG1", "1,006", "emit Increased(0,7)", 5],
      ["STOP", "0", "successful execution", 5],
    ],
    diffs: [
      ["Alice.nonce", "6", "7", "nonce consumed", 6],
      ["Counter.slot0", "0x0", "0x7", "storage persists", 6],
      ["Counter.logs", "none", "Increased(0,7)", "log in receipt only", 6],
      ["Block.stateRoot", "0x9d82...114a", "0xf38a...c201", "storage trie updated", 6],
    ],
    finality: [
      ["latest", "T+4.5s", "receipt exists, not final", 5],
      ["safe", "T+16.8s", "safe block >= 184", 6],
      ["finalized", "T+65.2s", "finalized checkpoint covers tx", 6],
    ],
    record: {
      txHash: "0x51f82c50e4515cf4b72e3d12fb1b0760ac4ccb468a10e574a7ee3968d911238e",
      activityType: "call",
      rpcAcceptedAt: "T+0.25s",
      firstSeenByNodeA: "T+0.25s",
      firstSeenByNodeB: "T+0.80s",
      includedSlot: 184,
      proposerIndex: 8,
      blockHash: "0xae97af8dc106783ae469f62a2c2c3fae3f6cfdb38d1ab81111f8308d93ad44e1",
      transactionIndex: 1,
      status: 1,
      gasUsed: "41457",
      effectiveGasPrice: "1.82 gwei",
      stateDiff: {
        "Counter.slot0": "0 -> 7",
        logs: "Increased(0,7)",
      },
      safeAt: "T+16.8s",
      finalizedAt: "T+65.2s",
    },
  },
  receive: {
    label: "receive()",
    title: "Tx 4: Contract receive()",
    subtitle: "EOA sends ETH to a contract with empty calldata; receive() executes and emits a deposit log",
    type: "receive",
    txHash: "0xd1e9051b8b26d9ae5a41c3f7f4a8c145812a4d28b19611f8f3a13ffdbac711ee",
    txFields: [
      ["type", "0x02 / EIP-1559", 0],
      ["chainId", "0x7e7 / local PoS devnet", 0],
      ["nonce", "0x07", 0],
      ["from", ADDRESSES.alice, 0],
      ["to", ADDRESSES.counter, 0],
      ["value", "0x3782dace9d90000 / 0.25 ETH", 0],
      ["input", "0x", 0],
      ["dispatch", "empty calldata + nonzero value -> receive()", 0],
      ["gas", "0x9c40 / 40,000", 0],
      ["maxFeePerGas", "0x77359400 / 2 gwei", 0],
    ],
    interface: [
      ["DApp button", "Deposit 0.25 ETH", 0],
      ["contract entry", "receive() external payable", 0],
      ["calldata", "0x, so no function selector is present", 0],
      ["contrast", "EOA transfer uses 21,000 gas; contract receive runs code and uses more gas", 5],
    ],
    abi: [
      ["ABI selector", "none", 0],
      ["trigger rule", "msg.data.length == 0 and msg.value > 0", 0],
      ["event", "Deposit(address indexed sender, uint256 amount)", 5],
      ["topic0", "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c", 5],
    ],
    preflight: [
      ["eth_getBalance(CounterVault)", "0 ETH", 0],
      ["eth_getTransactionCount(pending)", "0x07", 0],
      ["eth_estimateGas", "0x9c40", 0],
      ["eth_call", "simulates receive() and log path without changing balance", 0],
    ],
    signing: [
      ["unsigned tx", "02 f8 74 82 07 e7 07 ... value=0.25ETH data=0x", 1],
      ["signing hash", "0x9e8ad3e9c1e543f651c146f709088a55d365db4b31dc4ab34497d412fb410d3a", 1],
      ["yParity", "0x00", 1],
      ["r", "0x71c44fcf5a1597fa8db5fc79059ebdc19c29dfd5a09d2187e030e92bcb5fe581", 1],
      ["s", "0x12e5a1d1fe6bc682f6e5b2a6615d936dff2d851320af0bc0080aa9f72da93820", 1],
      ["raw tx", "0x02f8748207e707843b9aca008477359400829c4094c0de...80c0", 1],
    ],
    rpc: [
      ["eth_sendRawTransaction", "RPC accepts a signed value transfer to contract code", 2],
      ["eth_getTransactionByHash", "pending tx shows to=CounterVault, value=0.25 ETH, input=0x", 2],
      ["eth_getLogs", "Deposit log is only queryable after inclusion", 5],
    ],
    txpool: [
      ["Node A / geth-0", "T+0.24s", "pending", "nonce 7", "accepted by RPC", 3],
      ["Node B / geth-1", "T+0.83s", "pending", "nonce 7", "seen over EL P2P", 3],
    ],
    builder: [
      ["T+3.8s", "lighthouse-1", "engine_forkchoiceUpdated", "prepare slot 185 payload", 4],
      ["T+4.0s", "geth-1", "engine_getPayload", "payload includes receive() deposit", 4],
      ["T+4.2s", "validator-1", "Beacon block proposed", "slot 185, proposer index 19", 4],
      ["T+4.6s", "geth-0", "engine_newPayload", "Node A replays receive() and checks receipt root", 4],
    ],
    receipt: [
      ["blockNumber", "0xb9 / 185", 5],
      ["transactionIndex", "0x0", 5],
      ["status", "0x1", 5],
      ["gasUsed", "0x7e12 / 32,274", 5],
      ["logs[0].topics[0]", "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c", 5],
      ["logs[0].data", "amount=0.25 ETH", 5],
    ],
    trace: [
      ["CALLDATASIZE", "2", "calldata is empty", 5],
      ["CALLVALUE", "2", "msg.value is 0.25 ETH", 5],
      ["JUMP receive", "8", "dispatcher chooses receive()", 5],
      ["LOG2", "1,381", "emit Deposit(sender, amount)", 5],
      ["STOP", "0", "contract balance keeps the ETH", 5],
    ],
    diffs: [
      ["Alice.nonce", "7", "8", "nonce consumed", 6],
      ["Alice.balance", "98.9997 ETH", "98.74964 ETH", "value + gas paid", 6],
      ["CounterVault.balance", "0 ETH", "0.25 ETH", "contract balance increases", 6],
      ["CounterVault.slot0", "0x7", "0x7", "storage value unchanged", 6],
    ],
    finality: [
      ["latest", "T+4.6s", "receipt and Deposit log exist", 5],
      ["safe", "T+16.6s", "safe head contains deposit", 6],
      ["finalized", "T+66.2s", "checkpoint finalizes deposit", 6],
    ],
    record: {
      txHash: "0xd1e9051b8b26d9ae5a41c3f7f4a8c145812a4d28b19611f8f3a13ffdbac711ee",
      activityType: "receive",
      rpcAcceptedAt: "T+0.24s",
      firstSeenByNodeA: "T+0.24s",
      firstSeenByNodeB: "T+0.83s",
      includedSlot: 185,
      proposerIndex: 19,
      transactionIndex: 0,
      status: 1,
      gasUsed: "32274",
      stateDiff: {
        "CounterVault.balance": "0 -> 0.25 ETH",
        "CounterVault.slot0": "7 -> 7",
        logs: "Deposit(Alice,0.25 ETH)",
      },
      safeAt: "T+16.6s",
      finalizedAt: "T+66.2s",
    },
  },
  typed712: {
    label: "DApp 712",
    title: "Tx 5: EIP-712 dApp call",
    subtitle: "Alice signs typed data off-chain; a relayer submits an ABI call that verifies the signature on-chain",
    type: "typed712",
    txHash: "0x7120d0b56a25e56df265e782012ae27033d999d2bb7961b307b655d190e07120",
    txFields: [
      ["type", "0x02 / EIP-1559", 0],
      ["chainId", "0x7e7 / local PoS devnet", 0],
      ["nonce", "0x02", 0],
      ["from", ADDRESSES.relayer, 0],
      ["to", ADDRESSES.counter, 0],
      ["value", "0x0", 0],
      ["input", "0x1d6290c2 + owner + amount + deadline + v/r/s", 0],
      ["selector", "0x1d6290c2 / executeIncreaseWithSig(...)", 0],
      ["gas", "0x0186a0 / 100,000", 0],
      ["maxFeePerGas", "0x77359400 / 2 gwei", 0],
    ],
    interface: [
      ["DApp screen", "Authorized increase", 0],
      ["wallet RPC", "eth_signTypedData_v4(Alice, typedData)", 1],
      ["typed domain", "name=CounterVault, version=1, chainId=0x7e7, verifyingContract=CounterVault", 1],
      ["typed message", "owner=Alice, amount=7, nonce=0, deadline=1700000000", 1],
      ["submitter", "Relayer pays gas and broadcasts the on-chain transaction", 2],
    ],
    abi: [
      ["function signature", "executeIncreaseWithSig(address,uint256,uint256,uint8,bytes32,bytes32)", 0],
      ["selector", "keccak256(signature)[0:4] = 0x1d6290c2", 0],
      ["ABI args", "owner, amount, deadline, v, r, s", 0],
      ["on-chain check", "contract rebuilds EIP-712 digest and uses ecrecover", 5],
      ["business effect", "value increases only if signer is Alice and nonce/deadline are valid", 5],
    ],
    preflight: [
      ["eth_call", "simulates signature verification and increase without changing state", 0],
      ["eth_estimateGas", "0x0186a0", 0],
      ["eth_getStorageAt(slot 0)", "0x7", 0],
      ["CounterVault.eip712Nonces(Alice)", "0", 0],
      ["eth_getTransactionCount(relayer,pending)", "0x02", 0],
    ],
    signing: [
      ["EIP-712 digest", "0x4f2ac39dfc4b2b89c0886f4db4da9d945297ce2c4c8f00df81d4e9f7996c7120", 1],
      ["Alice typed signature", "0x3a31...f9211b", 1],
      ["relayer tx hash", "0x7b56df2b38a93087d8e87ad78e3d73fd215c0ee3f0d5161cc1ccfe9f2d22b712", 1],
      ["yParity", "0x01", 1],
      ["raw tx", "0x02f9012d8207e702843b9aca008477359400830186a094c0de...1d6290c2...", 1],
    ],
    rpc: [
      ["eth_signTypedData_v4", "wallet signs typed data; this is not a chain transaction", 1],
      ["eth_sendRawTransaction", "relayer broadcasts signed Type-2 transaction", 2],
      ["eth_getTransactionByHash", "from=Relayer, to=CounterVault, input selector=0x1d6290c2", 2],
    ],
    broadcast: [
      ["wallet boundary", "Alice signs EIP-712 typed data; no txpool entry is created", 1],
      ["relayer build", "relayer ABI-encodes executeIncreaseWithSig and signs a Type-2 transaction", 1],
      ["Node A RPC", "eth_sendRawTransaction validates relayer nonce, fee cap, and transaction signature", 2],
      ["txpool", "pending under relayer sender/nonce, not Alice sender/nonce", 3],
      ["EVM boundary", "Alice authorization is checked by contract code during execution", 5],
    ],
    txpool: [
      ["Node A / geth-0", "T+0.29s", "pending", "relayer nonce 2", "accepted by RPC", 3],
      ["Node B / geth-1", "T+0.94s", "pending", "relayer nonce 2", "seen over EL P2P", 3],
    ],
    builder: [
      ["T+3.8s", "lighthouse-0", "engine_forkchoiceUpdated", "prepare slot 186 payload", 4],
      ["T+4.0s", "geth-0", "engine_getPayload", "payload includes relayer tx", 4],
      ["T+4.1s", "validator-0", "Beacon block proposed", "slot 186, proposer index 8", 4],
      ["T+4.5s", "geth-1", "engine_newPayload", "re-executes ecrecover, nonce update, SSTORE", 4],
    ],
    receipt: [
      ["blockNumber", "0xba / 186", 5],
      ["transactionIndex", "0x1", 5],
      ["status", "0x1", 5],
      ["gasUsed", "0x012ab4 / 76,468", 5],
      ["logs[0].topics[0]", "0x122ba41a327e85eebd92ebba23e4451b74d89ce9bb4f7862fe247c1a8a8e4755", 5],
      ["logs[0].data", "owner=Alice, oldValue=7, newValue=14", 5],
    ],
    trace: [
      ["CALLDATALOAD", "3", "read owner, amount, deadline, v/r/s", 5],
      ["SLOAD nonce", "2,100", "read eip712Nonces[Alice]=0", 5],
      ["KECCAK256", "42", "rebuild typed-data digest", 5],
      ["ECRECOVER", "3,000", "recover signer from Alice signature", 5],
      ["SSTORE", "20,000", "value 7 -> 14 and nonce 0 -> 1", 5],
      ["LOG1", "1,006", "emit IncreasedBySig(Alice,7,14)", 5],
    ],
    diffs: [
      ["Relayer.nonce", "2", "3", "relayer tx nonce consumed", 6],
      ["Relayer.balance", "5 ETH", "4.99986 ETH", "relayer pays gas", 6],
      ["Alice.nonce", "8", "8", "typed-data signing does not consume account nonce", 6],
      ["CounterVault.slot0", "0x7", "0xe", "authorized increase persists", 6],
      ["CounterVault.nonces[Alice]", "0", "1", "signature replay protection", 6],
    ],
    finality: [
      ["latest", "T+4.5s", "receipt exists after relayer tx inclusion", 5],
      ["safe", "T+16.7s", "safe head contains EIP-712 execution", 6],
      ["finalized", "T+65.8s", "checkpoint finalizes the relayed call", 6],
    ],
    record: {
      txHash: "0x7120d0b56a25e56df265e782012ae27033d999d2bb7961b307b655d190e07120",
      activityType: "eip712_relayed_call",
      walletStep: "eth_signTypedData_v4 by Alice",
      chainStep: "eth_sendRawTransaction by relayer",
      rpcAcceptedAt: "T+0.29s",
      firstSeenByNodeA: "T+0.29s",
      firstSeenByNodeB: "T+0.94s",
      includedSlot: 186,
      proposerIndex: 8,
      transactionIndex: 1,
      status: 1,
      gasUsed: "76468",
      stateDiff: {
        "Alice.accountNonce": "8 -> 8",
        "Relayer.nonce": "2 -> 3",
        "CounterVault.slot0": "7 -> 14",
        "CounterVault.nonces[Alice]": "0 -> 1",
      },
      safeAt: "T+16.7s",
      finalizedAt: "T+65.8s",
    },
  },
  fail: {
    label: "Revert",
    title: "Tx 6: Reverting contract call",
    subtitle: "included on chain, business execution fails, nonce and gas are still consumed",
    type: "revert",
    txHash: "0x1ed396411c210c067b5b775cfdb153af3bd40aa28e8aa9ff1994b7e86cf66e7a",
    txFields: [
      ["type", "0x02 / EIP-1559", 0],
      ["chainId", "0x7e7 / local PoS devnet", 0],
      ["nonce", "0x07", 0],
      ["from", ADDRESSES.alice, 0],
      ["to", ADDRESSES.counter, 0],
      ["value", "0x0", 0],
      ["input", "0x1a352851", 0],
      ["selector", "0x1a352851 / alwaysFail()", 0],
      ["gas", "0x6ddd / 28,125", 0],
    ],
    preflight: [
      ["eth_call", "reverts with Error(\"demo revert\")", 0],
      ["eth_estimateGas", "fails unless gas limit is supplied", 0],
      ["eth_getStorageAt(slot 0)", "0x7", 0],
      ["eth_getTransactionCount(pending)", "0x07", 0],
    ],
    signing: [
      ["unsigned tx", "02 f8 70 82 07 e7 07 ... 1a352851", 1],
      ["signing hash", "0x3ef12ebbd5e6d97093161c21f40c064c565fbf0fa4bf233f8e329c447158ba34", 1],
      ["yParity", "0x00", 1],
      ["r", "0x0c3156ff6d83ae567f96f14e8411ac3a85f48ca786412952263909ff03cb9dbe", 1],
      ["s", "0x7b9e0b7d367b509cf02764302dd7c80f6ce31c05b885eb82e772751e63a2ef91", 1],
      ["raw tx", "0x02f8738207e707843b9aca008477359400826ddd94c0de...", 1],
    ],
    rpc: [
      ["eth_sendRawTransaction", "accepted; RPC did not execute final block context yet", 2],
      ["eth_getTransactionByHash", "pending tx has selector 0x1a352851", 2],
    ],
    txpool: [
      ["Node A / geth-0", "T+0.20s", "pending", "nonce 7", "accepted despite future revert", 3],
      ["Node B / geth-1", "T+0.78s", "pending", "nonce 7", "propagated over EL P2P", 3],
    ],
    builder: [
      ["T+3.8s", "lighthouse-1", "engine_forkchoiceUpdated", "build slot 185 payload", 4],
      ["T+3.9s", "geth-1", "engine_getPayload", "payload includes reverting tx", 4],
      ["T+4.2s", "validator-1", "Beacon block proposed", "slot 185, proposer index 19", 4],
      ["T+4.5s", "geth-0", "engine_newPayload", "re-executes and observes REVERT", 4],
    ],
    receipt: [
      ["blockNumber", "0xb9 / 185", 5],
      ["transactionIndex", "0x0", 5],
      ["status", "0x0", 5],
      ["gasUsed", "0x6331 / 25,393", 5],
      ["revert data", "0x08c379a0a... demo revert", 5],
      ["logs", "[]", 5],
    ],
    trace: [
      ["PUSH4", "3", "selector 0x1a352851", 5],
      ["JUMPI", "10", "dispatch to alwaysFail()", 5],
      ["MSTORE", "12", "encode Error(string)", 5],
      ["REVERT", "0", "rollback storage writes", 5],
    ],
    diffs: [
      ["Alice.nonce", "7", "8", "nonce consumed", 6],
      ["Alice.balance", "98.9998 ETH", "98.999752 ETH", "gas paid", 6],
      ["Counter.slot0", "0x7", "0x7", "storage rolled back", 6],
      ["Receipt.status", "none", "0", "included but failed", 6],
    ],
    finality: [
      ["latest", "T+4.5s", "status=0 receipt exists", 5],
      ["safe", "T+16.3s", "safe head contains failed tx", 6],
      ["finalized", "T+66.0s", "failed tx is final too", 6],
    ],
    record: {
      txHash: "0x1ed396411c210c067b5b775cfdb153af3bd40aa28e8aa9ff1994b7e86cf66e7a",
      activityType: "call_revert",
      rpcAcceptedAt: "T+0.20s",
      firstSeenByNodeA: "T+0.20s",
      firstSeenByNodeB: "T+0.78s",
      includedSlot: 185,
      proposerIndex: 19,
      blockHash: "0xa341d1a1f5e6fdbe2aa1117c0e112f7a125079db91f24aa179266a2a219671fa",
      transactionIndex: 0,
      status: 0,
      gasUsed: "25393",
      effectiveGasPrice: "1.86 gwei",
      stateDiff: {
        "Alice.nonce": "7 -> 8",
        "Counter.slot0": "7 -> 7",
        result: "included, reverted",
      },
      safeAt: "T+16.3s",
      finalizedAt: "T+66.0s",
    },
  },
  gap: {
    label: "Nonce gap",
    title: "Experiment: nonce gap",
    subtitle: "A received transaction can stay queued until the missing nonce arrives",
    type: "gap",
    txHash: "0x6a90000000000000000000000000000000000000000000000000000000000009",
    txFields: [
      ["account pending nonce", "0x08", 0],
      ["first raw tx nonce", "0x09", 1],
      ["second raw tx nonce", "0x08", 3],
      ["same sender", ADDRESSES.alice, 0],
      ["same type", "0x02 / EIP-1559", 0],
      ["gap tx result", "queued before nonce 8, pending after nonce 8", 6],
    ],
    preflight: [
      ["eth_getTransactionCount(pending)", "0x08", 0],
      ["build nonce 9 tx", "valid signature, future nonce", 1],
      ["eth_sendRawTransaction(nonce 9)", "accepted into queued", 2],
      ["eth_sendRawTransaction(nonce 8)", "fills the gap", 3],
    ],
    signing: [
      ["nonce 9 raw tx", "0x02f86f8207e709843b9aca00...", 1],
      ["nonce 9 hash", "0xbad09ce000000000000000000000000000000000000000000000000000000009", 1],
      ["nonce 8 raw tx", "0x02f86f8207e708843b9aca00...", 3],
      ["nonce 8 hash", "0xfeed08ce00000000000000000000000000000000000000000000000000000008", 3],
    ],
    rpc: [
      ["txpool_contentFrom after nonce 9", "queued[9], pending empty", 3],
      ["txpool_contentFrom after nonce 8", "pending[8], pending[9], queued empty", 4],
      ["eth_getTransactionByHash(nonce 9)", "blockHash null until included", 4],
    ],
    txpool: [
      ["Node A / geth-0", "T+0.21s", "queued", "nonce 9", "missing nonce 8", 3],
      ["Node B / geth-1", "T+0.92s", "queued", "nonce 9", "propagated but not executable", 3],
      ["Node A / geth-0", "T+1.34s", "pending", "nonce 8 + 9", "gap filled, both executable", 4],
      ["Node B / geth-1", "T+1.90s", "pending", "nonce 8 + 9", "promoted after propagation", 4],
    ],
    builder: [
      ["T+4.0s", "geth-0", "engine_getPayload", "payload orders nonce 8 before nonce 9", 4],
      ["T+4.2s", "validator-0", "Beacon block proposed", "both txs can be included", 4],
      ["T+4.6s", "geth-1", "engine_newPayload", "validates sender nonce sequence", 4],
    ],
    receipt: [
      ["nonce 8 status", "0x1", 5],
      ["nonce 9 status", "0x1", 5],
      ["ordering", "transactionIndex 0 then 1", 5],
    ],
    trace: [
      ["Nonce check", "0", "nonce 9 cannot execute while account nonce is 8", 3],
      ["Promotion", "0", "nonce 8 arrival makes nonce 9 contiguous", 4],
      ["Block execution", "0", "state nonce moves 8 -> 9 -> 10", 5],
    ],
    diffs: [
      ["txpool.queued", "nonce 9", "empty", "gap filled", 6],
      ["txpool.pending", "empty", "nonce 8, nonce 9", "both executable", 6],
      ["Alice.nonce", "8", "10", "two txs included", 6],
    ],
    finality: [
      ["latest", "T+4.6s", "both receipts exist", 5],
      ["safe", "T+16.9s", "safe head contains both txs", 6],
      ["finalized", "T+67.3s", "queue experiment is final", 6],
    ],
    record: {
      activityType: "nonce_gap",
      firstTx: "nonce 9 queued",
      secondTx: "nonce 8 pending",
      txpoolTransition: "queued[9] -> pending[8,9]",
      includedSlot: 186,
      stateDiff: {
        "Alice.nonce": "8 -> 10",
        "NodeA.queued": "nonce 9 -> empty",
        "NodeA.pending": "empty -> nonce 8, nonce 9",
      },
      safeAt: "T+16.9s",
      finalizedAt: "T+67.3s",
    },
  },
};

let activeKey = "transfer";
let activeType = "2";
let stage = 0;
let timer = null;
let lastInfraEventCount = 0;

const app = document.querySelector("#app");
const LIVE_RECORD_PATH = "./output/live-record.json";
const infraLab = createInfraLab(handleInfraLabChange);

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function experimentEvent(experiment, matcher) {
  const events = experiment?.events || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (matcher.test(events[index].action)) return events[index];
  }
  return null;
}

function buildExperimentUiTx(labState) {
  const experiment = labState.experiment;
  const tx = experiment.tx || {};
  const receipt = experiment.receipt || {};
  const block = experiment.block || {};
  const txpoolEvent = experimentEvent(experiment, /txpool/i);
  const receiptEvent = experimentEvent(experiment, /Receipt/i);
  const broadcastEvent = experimentEvent(experiment, /wallet returned/i);
  const latestEvent = experimentEvent(experiment, /latest block/i);
  const trace = experiment.trace;
  const txpool = experiment.txpool || { status: "waiting", detail: "awaiting txpool observation" };
  const receiptRows = receipt.blockNumber
    ? [
        ["blockNumber", `${receipt.blockNumber} / ${hexToDecimal(receipt.blockNumber)}`, 5],
        ["transactionIndex", receipt.transactionIndex || "unknown", 5],
        ["status", receipt.status || "unknown", 5],
        ["gasUsed", receipt.gasUsed ? `${receipt.gasUsed} / ${hexToDecimal(receipt.gasUsed)}` : "unknown", 5],
        ["effectiveGasPrice", receipt.effectiveGasPrice || "unknown", 5],
        ["logs", Array.isArray(receipt.logs) ? String(receipt.logs.length) : "unknown", 5],
      ]
    : [["receipt", "等待 eth_getTransactionReceipt", 5]];
  const traceRows = trace
    ? [
        [trace.type || "CALL", trace.gasUsed || "-", trace.error || `from ${trace.from || experiment.from} to ${trace.to || experiment.to}`, 5],
        [trace.error ? "ERROR" : "RETURN", "0", trace.output || "callTracer completed", 5],
      ]
    : [["debug_traceTransaction", "-", receipt.blockNumber ? "RPC 不支持或未启用 debug API" : "等待 receipt", 5]];
  const finalityRows = [
    ["latest", latestEvent?.at || "waiting", receipt.blockNumber ? `receipt in ${receipt.blockNumber}` : "waiting for inclusion", 5],
    ["safe", experiment.safeAt || "waiting", experiment.safeAt ? "safe block covers transaction" : "waiting / unsupported", 6],
    ["finalized", experiment.finalizedAt || "waiting", experiment.finalizedAt ? "finalized block covers transaction" : "waiting / unsupported", 6],
  ];

  return {
    label: "Experiment",
    title: "Interactive Tx: wallet to chain",
    subtitle: "A transaction constructed by this page, authorized by an EIP-1193 wallet, and observed through the selected RPC.",
    type: "experiment",
    txHash: experiment.txHash || "awaiting-wallet-signature",
    txFields: [
      ["type", tx.type || "wallet-selected", 0],
      ["chainId", `${experiment.chainId} / ${hexToDecimal(experiment.chainId)}`, 0],
      ["nonce", tx.nonce || experiment.preflight.nonce || "waiting", 0],
      ["from", experiment.from, 0],
      ["to", experiment.to, 0],
      ["value", `${experiment.valueHex} / ${experiment.valueWei} wei`, 0],
      ["input", experiment.data, 0],
      ["gas", tx.gas || experiment.preflight.gas || "waiting", 0],
      ["maxFeePerGas", tx.maxFeePerGas || "wallet-selected", 0],
      ["maxPriorityFeePerGas", tx.maxPriorityFeePerGas || experiment.preflight.priorityFee || "wallet-selected", 0],
    ],
    interface: [
      ["DApp action", "Send test ETH transfer", 0],
      ["Execution RPC observer", experiment.rpcDisplayUrl, 0],
      ["wallet", "EIP-1193 provider; private key never exposed", 1],
    ],
    preflight: [
      ["eth_chainId", experiment.chainId, 0],
      ["eth_getTransactionCount(pending)", experiment.preflight.nonce || "waiting", 0],
      ["eth_estimateGas", experiment.preflight.gas || "waiting", 0],
      ["eth_maxPriorityFeePerGas", experiment.preflight.priorityFee || "unavailable", 0],
      ["sender balance before", experiment.beforeFromBalance || "unknown", 0],
      ["recipient balance before", experiment.beforeToBalance || "unknown", 0],
    ],
    signing: [
      ["wallet API", "eth_sendTransaction", 1],
      ["authorization", broadcastEvent ? "user approved in wallet" : "awaiting wallet confirmation", 1],
      ["private key", "never exposed to this page", 1],
      ["raw transaction", "wallet does not expose signed raw bytes", 1],
      ["transaction hash", experiment.txHash || "waiting", 1],
    ],
    rpc: (experiment.events || [])
      .filter((event) => event.stage >= 1 && event.stage <= 6)
      .map((event) => [event.action, `${event.at} · ${event.result}`, Math.min(event.stage, 5)]),
    broadcast: [
      ["Web", "constructs the transaction request and preflights through selected RPC", 0],
      ["Browser wallet", "shows user confirmation, signs internally, and broadcasts via its active chain provider", 2],
      ["Selected RPC", "independently observes txHash, txpool availability, receipt, and block", 3],
      ["Boundary", "selected observer RPC may differ from the wallet's broadcast endpoint even when chainId matches", 4],
    ],
    txpool: [
      [
        labState.rpc.displayUrl || "selected execution RPC",
        txpoolEvent?.at || "waiting",
        txpool.status || "unknown",
        experiment.preflight.nonce ? `nonce ${hexToDecimal(experiment.preflight.nonce)}` : "nonce waiting",
        txpool.detail || "waiting for txpool_contentFrom",
        3,
      ],
    ],
    builder: [
      [
        receiptEvent?.at || "waiting",
        labState.rpc.displayUrl || "execution RPC",
        receipt.blockNumber ? "eth_getBlockByHash" : "awaiting inclusion",
        block.number ? `execution block ${hexToDecimal(block.number)}` : "block unavailable",
        4,
      ],
      [
        "context",
        labState.rpc.beaconUrl ? "Beacon API" : "not configured",
        labState.rpc.beaconUrl ? "beacon head / finality" : "validator internals unavailable",
        labState.rpc.beaconUrl
          ? `head slot ${labState.rpc.beaconHead || "unknown"}, finalized epoch ${labState.rpc.finalizedEpoch || "unknown"}`
          : "Execution RPC alone cannot expose proposer or Engine API actions",
        4,
      ],
    ],
    receipt: receiptRows,
    trace: traceRows,
    diffs: [
      ["sender.balance", experiment.beforeFromBalance || "unknown", experiment.afterFromBalance || "waiting", "value + gas", 6],
      ["recipient.balance", experiment.beforeToBalance || "unknown", experiment.afterToBalance || "waiting", `${experiment.valueWei} wei transfer`, 6],
      ["sender.nonce", experiment.preflight.nonce || "unknown", tx.nonce ? `${hexToDecimal(tx.nonce)} → ${BigInt(tx.nonce) + 1n}` : "waiting", "nonce consumed after inclusion", 6],
      ["block.stateRoot", "-", block.stateRoot || "waiting", "post-state root", 6],
    ],
    finality: finalityRows,
    record: {
      activityType: "interactive_wallet_transfer",
      source: "browser-infra-lab",
      chainId: experiment.chainId,
      txHash: experiment.txHash || null,
      rpc: experiment.rpcDisplayUrl,
      blockNumber: receipt.blockNumber || null,
      blockHash: receipt.blockHash || null,
      transactionIndex: receipt.transactionIndex || null,
      status: receipt.status || null,
      gasUsed: receipt.gasUsed || null,
      from: experiment.from,
      to: experiment.to,
      valueWei: experiment.valueWei,
      safeAt: experiment.safeAt || null,
      finalizedAt: experiment.finalizedAt || null,
      observationEvents: experiment.events,
    },
  };
}

function handleInfraLabChange(labState) {
  const experiment = labState.experiment;
  if (experiment) {
    TXS.experiment = buildExperimentUiTx(labState);
    const eventCount = experiment.events?.length || 0;
    if (eventCount > lastInfraEventCount || activeKey === "experiment") {
      activeKey = "experiment";
      stage = experiment.stage;
      stopJourneyTimer();
    }
    lastInfraEventCount = eventCount;
  }
  renderWalkthrough();
}

function renderBroadcastRows(tx) {
  return tx.broadcast || [
    ["本地签名器", "先生成 serialized raw transaction；此时 RPC 还没有看到交易", 1],
    ["Node A RPC", "eth_sendRawTransaction 检查 envelope、签名、nonce、fee cap 与 intrinsic gas", 2],
    ["本地 txpool", "当前可执行则进入 pending；sender nonce 有缺口时进入 queued", 3],
    ["EL P2P gossip", "Node A 广播交易，Node B 独立检查后放入自己的 txpool", 3],
    ["Payload 边界", "Validator Client 不执行 Solidity；CL 通过 Engine API 请求 EL 构建 payload", 4],
  ];
}

function renderValidatorRows(tx) {
  return tx.validator || [
    ["Slot duty", "Beacon state 确定本 slot 的 proposer", "Validator Client 准备请求区块提议", 4],
    ["Payload attributes", "Consensus Client 发送 engine_forkchoiceUpdated", "Execution Client 基于当前 head 开始构建 payload", 4],
    ["选择交易", "Execution Client 从本地 txpool 选择有效交易", "同时检查 nonce 顺序、gas 与 block gas limit", 4],
    ["提议区块", "Validator Client 签署 Beacon Block", "Execution payload 被放进 Beacon Block body", 4],
    ["Attestation", "其他 validators 对 head 投票", "safe / finalized 会晚于 transaction receipt", 6],
  ];
}

function typeDef() {
  return TX_TYPES[activeType];
}

function compatibilityLabel(tx, def) {
  if (tx.type === "deploy" && (activeType === "3" || activeType === "4")) {
    return "Incompatible with this activity: this envelope requires a non-null destination.";
  }
  if (activeType === "3" && tx.type !== "deploy") {
    return "Valid only when blobVersionedHashes and matching blob sidecar data are present.";
  }
  if (activeType === "4") {
    return "Valid only when authorizationList is non-empty; execution may still call the destination.";
  }
  return def.chainNote;
}

function activityFields(tx, def) {
  const filtered = tx.txFields.filter(([name]) => {
    return !["type", "maxFeePerGas", "maxPriorityFeePerGas"].includes(name);
  });
  return [["type", def.typeValue, 0], ...filtered, ...def.feeRows, ...def.extraRows];
}

function signingRows(tx, def) {
  const baseHash = tx.signing.find((row) => row[0] === "signing hash")?.[1] || "0x...";
  const rawLengthHint = activeType === "0" ? "legacy RLP length varies by payload" : `${def.badge} + typed payload`;
  return [
    ["signing preimage", def.signing, 1],
    ["sample digest", baseHash, 1],
    ["signature fields", def.signature, 1],
    ["raw tx prefix", def.rawPrefix, 1],
    ["raw length", rawLengthHint, 1],
  ];
}

function envelopeRows(tx, def) {
  return [
    ["envelope", def.envelope, 0],
    ["wire prefix", def.wirePrefix, 0],
    ["fee model", def.feeModel, 0],
    ["activity fit", compatibilityLabel(tx, def), 0],
  ];
}

function recordWithEnvelope(tx, def) {
  return {
    envelopeType: activeType,
    envelopeName: def.name,
    feeModel: def.feeModel,
    ...tx.record,
  };
}

function renderTypeTabs() {
  return Object.entries(TX_TYPES)
    .map(([key, def]) => {
      const selected = key === activeType ? "selected" : "";
      return `
        <button class="type-tab ${selected}" data-type="${esc(key)}">
          <span>${esc(def.tab)}</span>
          <strong>${esc(def.name)}</strong>
          <small>${esc(def.badge)}</small>
        </button>
      `;
    })
    .join("");
}

function renderJson(record) {
  return `<pre class="json">${esc(JSON.stringify(record, null, 2))}</pre>`;
}

const LIVE_STEP_EVIDENCE = [
  {
    label: "根据交易反推",
    tone: "inferred",
    note: "现有采集器没有记录用户在 Web 上点击了什么；这里只能根据最终交易反推原始意图。",
  },
  {
    label: "部分实测",
    tone: "partial",
    note: "链 ID、交易字段和部分余额来自真实节点；完整的 fee / estimateGas 预检查过程没有逐条抓取。",
  },
  {
    label: "部分实测",
    tone: "partial",
    note: "记录确认了 cast 的签名边界和 txHash，但没有保存完整 raw tx、签名摘要与 r/s 字段。",
  },
  {
    label: "实测",
    tone: "observed",
    note: "提交方式、txHash、交易查询和 receipt 查询来自这笔真实本地交易。",
  },
  {
    label: "采样过晚",
    tone: "partial",
    note: "这笔 Live 在读取 txpool 时已经入块，因此只能看到 not present，不能证明它此前没有进入 pending。",
  },
  {
    label: "上下文快照",
    tone: "partial",
    note: "Live 只读取了 execution block 与 Beacon head/finality 快照，没有抓到本次 Engine API 调用或 proposer 签名。",
  },
  {
    label: "实测",
    tone: "observed",
    note: "receipt、gasUsed、status、block 与 debug_traceTransaction 来自真实执行节点。",
  },
  {
    label: "部分实测",
    tone: "partial",
    note: "余额、nonce 与 stateRoot 来自真实查询；finality 只是当时 checkpoint 快照，尚未关联证明这笔交易已 finalized。",
  },
];

const SCENARIO_META = {
  transfer: {
    label: "普通转账",
    title: "示例：原生 ETH 转账",
    subtitle: "Alice 直接给 Bob 转账；没有 calldata，也不会执行合约代码。",
  },
  deploy: {
    label: "部署合约",
    title: "示例：部署 CounterVault",
    subtitle: "交易没有 to 地址，input 中携带 init code，执行后生成新的合约地址和代码。",
  },
  call: {
    label: "合约调用",
    title: "示例：调用 increase(7)",
    subtitle: "Web 把方法与参数编码成 calldata，EVM 执行后修改合约 storage。",
  },
  receive: {
    label: "合约收款",
    title: "示例：给合约转入 ETH",
    subtitle: "to 是合约地址、value 大于 0、calldata 为空，因此触发 receive()。",
  },
  typed712: {
    label: "签名代付",
    title: "示例：EIP-712 授权 + Relayer 代付",
    subtitle: "Alice 只做链下授权；Relayer 构造并发送真正的链上交易，同时支付 gas。",
  },
  fail: {
    label: "执行失败",
    title: "示例：交易入块后 Revert",
    subtitle: "交易可以进入区块但执行失败；合约状态回滚，sender 的 nonce 与 gas 仍被消耗。",
  },
  gap: {
    label: "Nonce 缺口",
    title: "示例：Nonce gap 与 txpool 排队",
    subtitle: "nonce 9 先到时进入 queued，nonce 8 到达后两笔交易才一起变成 pending。",
  },
  live: {
    label: "Live 实测",
    title: "真实记录：本地 ETH 转账",
    subtitle: "这是一笔曾经提交给本地 PoS devnet 的真实交易记录，并非刚刚生成的新交易。",
  },
  experiment: {
    label: "交互实验",
    title: "实时实验：钱包发起的交易",
    subtitle: "由当前页面构造、浏览器钱包授权，并通过选定 Execution RPC 实时观察的交易。",
  },
};

function scenarioMeta(tx) {
  return SCENARIO_META[activeKey] || {
    label: tx.label,
    title: tx.title,
    subtitle: tx.subtitle,
  };
}

function renderJourneyTabs() {
  return Object.entries(TXS)
    .map(([key, tx]) => {
      const selected = key === activeKey ? "selected" : "";
      const label = SCENARIO_META[key]?.label || tx.label;
      return `<button class="tab ${selected}" data-tx="${esc(key)}">${esc(label)}</button>`;
    })
    .join("");
}

function journeyEvidence() {
  if (activeKey === "live") return LIVE_STEP_EVIDENCE[stage];
  if (activeKey === "experiment") {
    const lab = infraLab.snapshot();
    const experiment = lab.experiment;
    const event = experiment?.events?.find((item) => item.stage === stage);
    const notes = [
      "Web 表单输入由当前页面实时记录。",
      "chainId、nonce、gas 与余额来自当前连接的 Execution RPC。",
      "钱包确认与 txHash 可观察；私钥、签名字段和 raw bytes 由钱包隔离，不暴露给页面。",
      "txHash 来自钱包 Provider；钱包实际广播端点可能与本页选择的观察 RPC 不同。",
      experiment?.txpool?.status === "unavailable"
        ? "当前 RPC 不开放 txpool namespace，因此只能继续通过 txHash / receipt 观察。"
        : "txpool_contentFrom 来自当前选择的 Execution RPC。",
      lab.rpc.beaconUrl
        ? "Execution block 来自 RPC；Beacon head/finality 来自可选 Beacon API，Engine API 仍不对浏览器开放。"
        : "只连接了 Execution RPC；proposer、validator 与 Engine API 内部动作无法被直接观察。",
      experiment?.receipt ? "receipt、block 和可用的 debug trace 来自当前 Execution RPC。" : "正在等待真实 receipt。",
      experiment?.finalizedAt ? "safe/finalized tag 已覆盖目标区块。" : "正在等待 safe/finalized，或当前 RPC 不支持这些 block tags。",
    ];
    return {
      label: event ? "实时实测" : "等待观察",
      tone: event ? "observed" : "partial",
      note: notes[stage],
    };
  }
  return {
    label: "教学示意",
    tone: "illustrative",
    note: "这个场景用于解释机制；时间、节点、hash 与执行结果是固定示例，不是当前节点日志。",
  };
}

function txField(tx, name, fallback = "未提供") {
  return tx.txFields?.find(([field]) => field === name)?.[1] || fallback;
}

function selectTxFields(tx, names) {
  return (tx.txFields || []).filter(([name]) => names.includes(name));
}

function rowValue(rows, matcher, fallback = "未记录") {
  const row = (rows || []).find(([name]) => {
    if (typeof matcher === "string") return name === matcher;
    return matcher.test(name);
  });
  return row?.[1] || fallback;
}

function builderEventDetail(tx, matcher, fallback = "未记录") {
  const event = (tx.builder || []).find((row) => matcher.test(row[2]));
  return event?.[3] || fallback;
}

function transactionRequestRows(tx) {
  return [
    ["from", txField(tx, "from")],
    ["to", txField(tx, "to")],
    ["value", txField(tx, "value", "0")],
    ["data", txField(tx, "input", "0x")],
  ];
}

function unsignedTransactionRows(tx) {
  return selectTxFields(tx, [
    "type",
    "chainId",
    "nonce",
    "to",
    "value",
    "input",
    "gas",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
  ]);
}

function signatureSummary(tx) {
  const parts = ["yParity", "r", "s"]
    .map((name) => {
      const value = rowValue(tx.signing, name, "");
      return value ? `${name}=${value}` : "";
    })
    .filter(Boolean);
  return parts.join(" · ") || rowValue(tx.signing, /signing boundary|send mode/i, "签名字段未保存");
}

function transformationModel(tx) {
  const scenario = scenarioMeta(tx);
  const pool = tx.txpool?.[0] || [];
  const receiptBlock = rowValue(tx.receipt, "blockNumber");
  const receiptStatus = rowValue(tx.receipt, "status");
  const receiptGas = rowValue(tx.receipt, "gasUsed");
  const requestRows = transactionRequestRows(tx);
  const unsignedRows = unsignedTransactionRows(tx);
  const rawTx = rowValue(tx.signing, /^raw tx$/i, "完整 raw bytes 未保留");
  const signingHash = rowValue(tx.signing, /signing hash|digest/i, "签名摘要未保留");
  const chainId = txField(tx, "chainId", rowValue(tx.preflight, "eth_chainId"));
  const nonce = txField(tx, "nonce", rowValue(tx.preflight, /TransactionCount/i));
  const gas = txField(tx, "gas", rowValue(tx.preflight, /estimateGas/i));
  const maxFee = txField(tx, "maxFeePerGas", "未记录");
  const priorityFee = txField(tx, "maxPriorityFeePerGas", "未记录");
  const blockHash = tx.record?.blockHash || "uiTx.record 未保存 blockHash";
  const slot = tx.record?.includedSlot || builderEventDetail(tx, /head|proposed/i);
  const txpoolWasCaptured = ["pending", "queued"].includes(pool[2]);
  const isTxpoolObservation = activeKey === "live" || (activeKey === "experiment" && !txpoolWasCaptured);
  const infraSnapshot = activeKey === "experiment" ? infraLab.snapshot() : null;
  const executionOnlyExperiment = activeKey === "experiment" && /^anvil\//i.test(infraSnapshot?.rpc.clientVersion || "");
  const builtBlockKind = executionOnlyExperiment ? "ExecutionBlock" : "ExecutionPayload";

  const models = [
    {
      input: {
        kind: "UIIntent",
        title: "用户在页面上表达的业务动作",
        rows: [
          ["场景", scenario.title],
          ["页面动作", tx.interface?.[0]?.[1] || tx.label],
          ["用户目标", tx.subtitle],
        ],
        note: "这里还是普通 Web 状态，没有交易格式，也没有链上副作用。",
      },
      operations: [
        {
          title: "读取页面状态",
          detail: "取得用户选择的接收方、金额或合约方法参数。",
          result: `to=${txField(tx, "to")} · value=${txField(tx, "value", "0")}`,
        },
        {
          title: "标准化业务参数",
          detail: "把 ETH 金额转成 wei；把合约方法和参数整理成 ABI 可编码的值。",
          result: tx.abi?.[2]?.[1] || txField(tx, "input", "0x"),
        },
        {
          title: "生成交易请求",
          detail: "只保留发起交易所需的 to、value、data 等最小字段。",
          result: "TransactionRequest ready",
        },
      ],
      output: {
        kind: "TransactionRequest",
        title: "交给钱包/SDK 的未补全请求",
        rows: requestRows,
        note: "它还没有 chainId、nonce、gas、fee 或签名。",
      },
      explanation: "页面意图经过单位换算与 ABI 参数整理，才从“用户想做什么”变成机器可继续处理的 TransactionRequest。",
    },
    {
      input: {
        kind: "TransactionRequest",
        title: "来自 Web 的最小交易请求",
        rows: requestRows,
        note: "这些字段表达业务目的，但还不足以签名和广播。",
      },
      operations: [
        {
          title: "读取链 ID",
          detail: "防止交易被拿到另一条链重放。",
          result: `chainId = ${chainId}`,
        },
        {
          title: "取得 pending nonce",
          detail: "决定这笔交易在 sender 交易序列中的位置。",
          result: `nonce = ${nonce}`,
        },
        {
          title: "估算 gas 与费用",
          detail: "模拟所需 gas，并补齐 maxFeePerGas / priority fee。",
          result: `gas=${gas} · maxFee=${maxFee} · priority=${priorityFee}`,
        },
        {
          title: "选择 envelope 并编码",
          detail: "把所有字段按交易类型组织成可签名的 payload。",
          result: `recorded type = ${txField(tx, "type", "unknown")}`,
        },
      ],
      output: {
        kind: "UnsignedTransaction",
        title: "字段完整、但尚未授权的交易",
        rows: unsignedRows,
        note: "字段一旦签名就不能再改；改动任意一项都会得到不同签名和 txHash。",
      },
      explanation: "只读 RPC 查询把链的当前状态补进请求，最终形成字段确定、可以交给钱包签名的 UnsignedTransaction。",
    },
    {
      input: {
        kind: "UnsignedTransaction",
        title: "等待账户授权的完整交易",
        rows: unsignedRows,
        note: "它说明要执行什么，但还不能证明 sender 同意。",
      },
      operations: [
        {
          title: "构造 signing preimage",
          detail: "按交易类型序列化不含最终签名字段的 payload。",
          result: typeDef().signing,
        },
        {
          title: "计算签名摘要",
          detail: "对 signing preimage 做 keccak256。",
          result: signingHash,
        },
        {
          title: "钱包使用私钥签名",
          detail: "私钥不离开钱包，产出 yParity、r、s。",
          result: signatureSummary(tx),
        },
        {
          title: "附加签名并序列化",
          detail: "把签名字段放回 envelope，生成可广播的 raw transaction。",
          result: rawTx,
        },
        {
          title: "计算交易哈希",
          detail: "对最终 raw tx 做 keccak256，得到全网引用它的 txHash。",
          result: tx.txHash,
        },
      ],
      output: {
        kind: "SignedRawTransaction",
        title: "已经授权、可以广播的字节串",
        rows: [
          ["from（由签名恢复）", txField(tx, "from")],
          ["signature", signatureSummary(tx)],
          ["raw tx", rawTx],
          ["txHash", tx.txHash],
        ],
        note: "签名发生在链外；到这里仍未进入任何节点。",
      },
      explanation: "签名把“字段完整的请求”变成不可篡改的授权指令；raw tx 中任何字节变化都会让签名或 txHash 改变。",
    },
    {
      input: {
        kind: "SignedRawTransaction",
        title: "Wallet 准备提交的 raw tx",
        rows: [
          ["method", "eth_sendRawTransaction"],
          ["params[0]", rawTx],
          ["client txHash", tx.txHash],
        ],
        note: "RPC 只负责把已签名交易交到 Execution Client 的入口。",
      },
      operations: [
        {
          title: "封装 JSON-RPC / HTTP",
          detail: "客户端把 raw tx 放进 method 与 params。",
          result: "JSON-RPC request id=1",
        },
        {
          title: "Gateway 路由请求",
          detail: "实际服务可能处理鉴权、限流和负载均衡，再转给一台执行节点。",
          result: "routed to Execution Node A",
        },
        {
          title: "调用节点 RPC 方法",
          detail: "执行节点接收 eth_sendRawTransaction；交易语义检查在下一步展开。",
          result: rowValue(tx.rpc, /sendRawTransaction|cast send|sendTransaction/i),
        },
        {
          title: "返回同步结果",
          detail: "成功时返回 txHash，失败时返回 JSON-RPC error。",
          result: tx.txHash,
        },
      ],
      output: {
        kind: "RPC Handoff",
        title: "节点得到 raw tx，客户端得到 txHash",
        rows: [
          ["node receives", "signed raw transaction"],
          ["client receives", tx.txHash],
          ["included?", "尚未保证"],
          ["executed successfully?", "尚未执行"],
        ],
        note: "RPC 返回成功不是上链成功，只是完成了提交交接。",
      },
      explanation: "这一段只改变“交易在哪里”：raw tx 从客户端跨过 RPC 边界到达节点；交易内容本身不会被 RPC 改写。",
    },
    {
      input: {
        kind: "RPC Handoff",
        title: "Execution Node 收到的已签名交易",
        rows: [
          ["txHash", tx.txHash],
          ["type", txField(tx, "type")],
          ["nonce", nonce],
          ["from", txField(tx, "from")],
          ["gas / maxFee", `${gas} / ${maxFee}`],
        ],
        note: "节点必须独立验证，不能因为 RPC 已返回就盲目信任。",
      },
      operations: [
        {
          title: "解码 envelope",
          detail: "识别交易类型并解析 chainId、nonce、gas、to、value、data 与签名。",
          result: `decoded ${txField(tx, "type", "transaction")}`,
        },
        {
          title: "恢复 sender",
          detail: "从签名恢复公钥地址，验证交易没有被篡改。",
          result: `from = ${txField(tx, "from")}`,
        },
        {
          title: "执行入池规则",
          detail: "检查 chainId、nonce、余额、intrinsic gas、fee cap 与节点策略。",
          result: isTxpoolObservation ? "入池返回未捕获或接口不可用；继续观察 txHash / receipt" : "accepted by local admission",
        },
        {
          title: "归类 txpool",
          detail: "nonce 连续则 pending；存在缺口则 queued；不合法则 rejected。",
          result: `observed status = ${pool[2] || "unknown"}`,
        },
        {
          title: "执行层 P2P 传播",
          detail: "向其他 Execution Nodes 宣告交易；对方仍会重新验证。",
          result: "peer txpools may now contain the tx",
        },
      ],
      output: {
        kind: isTxpoolObservation ? "TxpoolObservation" : "TxpoolEntry",
        title: isTxpoolObservation ? "观察 RPC 返回的 txpool 时点快照" : "本地节点对交易的排队结果",
        rows: [
          ["node", pool[0] || "unknown"],
          ["observed at", pool[1] || "unknown"],
          ["status", pool[2] || "unknown"],
          ["nonce", pool[3] || nonce],
          ["detail", pool[4] || "未记录"],
        ],
        note: activeKey === "live"
          ? "Live 的采样发生在入块后，因此 not present 不代表它从未 pending。"
          : activeKey === "experiment"
            ? "这是当前观察 RPC 的能力与时点结果；wallet 的广播 RPC 可能是另一台节点。"
            : "这是教学场景中的节点 txpool 快照。",
      },
      explanation: isTxpoolObservation
        ? "节点正常情况下会把通过 admission 的交易变成 TxpoolEntry；但当前只得到接口能力或采样时点结果，因此诚实显示为 TxpoolObservation。"
        : "节点把不可信的 raw bytes 逐项验证，只有通过本地 admission 规则后，才会把它变成可排队和传播的 TxpoolEntry。",
    },
    {
      input: {
        kind: executionOnlyExperiment ? "AutoMineContext" : "BuildContext",
        title: executionOnlyExperiment ? "Anvil 自动出块上下文" : "Proposer 本 slot 的构建上下文",
        rows: [
          ["current head", builderEventDetail(tx, /forkchoice|head/i)],
          ["candidate tx", tx.txHash],
          ["txpool status", pool[2] || "unknown"],
          ["slot / duty", slot],
        ],
        note: executionOnlyExperiment
          ? "Anvil 在收到交易后由本地执行节点自动产块，没有独立 CL 或 validator duty。"
          : "Proposer 只能从自己能看到的交易与当前 head 出发构建区块。",
      },
      operations: [
        {
          title: "获得 proposer duty",
          detail: executionOnlyExperiment ? "Execution-only Anvil 不运行 Beacon proposer 选择。" : "Beacon state 为当前 slot 选定 proposer。",
          result: executionOnlyExperiment ? "not present in Anvil" : `proposer = ${tx.record?.proposerIndex ?? "Live 未抓取"}`,
        },
        {
          title: "CL 通知 fork choice",
          detail: executionOnlyExperiment
            ? "没有 Consensus Client；Anvil 自己维护本地 head。"
            : "Consensus Client 调用 engine_forkchoiceUpdated，并附带 payload attributes。",
          result: executionOnlyExperiment ? "no Engine API boundary" : builderEventDetail(tx, /forkchoice|head/i),
        },
        {
          title: "EL 选择并排序交易",
          detail: executionOnlyExperiment
            ? "Anvil 接收有效交易后按 automine 规则直接构建下一个 execution block。"
            : "从本地 txpool 选择有效且可执行的交易，遵守 nonce 与 block gas limit。",
          result: `include tx ${tx.txHash}`,
        },
        {
          title: "执行候选 payload",
          detail: "Execution Client 预执行交易，计算 stateRoot、receiptsRoot 与 gasUsed。",
          result: `candidate status = ${receiptStatus}`,
        },
        {
          title: "取回 payload 并签块",
          detail: executionOnlyExperiment
            ? "Anvil 提交本地 execution block；没有 Beacon Block 或 validator BLS 签名。"
            : "CL 调用 engine_getPayload；Validator Client 签署 Beacon Block。",
          result: executionOnlyExperiment ? `execution block ${receiptBlock}` : builderEventDetail(tx, /getPayload|proposed/i),
        },
      ],
      output: {
        kind: builtBlockKind,
        title: executionOnlyExperiment ? "Anvil 生成的本地执行区块" : "嵌入 Beacon Block 的执行区块",
        rows: [
          ["slot", slot],
          ["blockNumber", receiptBlock],
          ["blockHash", blockHash],
          ["tx[transactionIndex]", `${tx.record?.transactionIndex ?? rowValue(tx.receipt, "transactionIndex")} → ${tx.txHash}`],
          ["proposerIndex", tx.record?.proposerIndex ?? "Live 未抓取"],
        ],
        note: executionOnlyExperiment
          ? "这是 execution block，不带 Beacon consensus envelope；不能用它学习 validator attestation。"
          : "这一步的输出不再是单笔交易，而是包含多笔交易及执行承诺的区块 payload。",
      },
      explanation: executionOnlyExperiment
        ? "Anvil 把有效交易直接执行并写入本地 ExecutionBlock；完整 PoS 网络在这里还会多出 CL 的 Engine API 协调和 Validator Client 签署 Beacon Block。"
        : "EL 把 TxpoolEntry 与当前链头组合、排序并预执行，CL/Validator 再把所得 ExecutionPayload 封装并签成可广播区块。",
    },
    {
      input: {
        kind: builtBlockKind,
        title: executionOnlyExperiment ? "Anvil 本地执行区块" : "其他节点收到的 proposed block",
        rows: [
          ["blockNumber", receiptBlock],
          ["blockHash", blockHash],
          ["transactionIndex", tx.record?.transactionIndex ?? rowValue(tx.receipt, "transactionIndex")],
          ["transaction", tx.txHash],
        ],
        note: executionOnlyExperiment
          ? "Anvil 单节点模式没有第二台 Execution Client 进行独立重放；这里展示本地执行结果。"
          : "其他节点不能直接相信 proposer 给出的执行结果。",
      },
      operations: [
        {
          title: "校验区块上下文",
          detail: "检查 parent、timestamp、gas limit 等执行区块约束。",
          result: "block context accepted for execution",
        },
        {
          title: "重做交易前置检查",
          detail: "再次检查签名、账户 nonce、余额与 gas。",
          result: `sender nonce = ${nonce}`,
        },
        {
          title: "应用状态转换",
          detail: "执行 ETH transfer 或进入 EVM 运行 calldata 对应代码。",
          result: tx.trace?.[0]?.[2] || "state transition executed",
        },
        {
          title: "生成 receipt",
          detail: "累计 gas、logs、status，并形成 receiptsRoot。",
          result: `status=${receiptStatus} · gasUsed=${receiptGas}`,
        },
        {
          title: "核对 payload roots",
          detail: "把本地计算结果与 proposer 声明的 roots 比较。",
          result: `VALID（区块有效；交易 receipt.status=${receiptStatus}）`,
        },
      ],
      output: {
        kind: "TransactionReceipt",
        title: "节点独立重放后的执行结果",
        rows: (tx.receipt || []).map(([name, value]) => [name, value]),
        note: "receipt.status 说明 EVM 是否成功；它与 RPC 是否接受交易是两件不同的事。",
      },
      explanation: "其他 Execution Clients 用同一输入重新计算；只有本地 receipt、state root 等结果与 payload 一致，区块才通过执行验证。",
    },
    {
      input: {
        kind: executionOnlyExperiment ? "ExecutionOnlyBlock" : "ValidatedBlock",
        title: executionOnlyExperiment ? "Anvil 已写入的 execution block" : "执行层已判定有效的区块",
        rows: [
          ["blockNumber", receiptBlock],
          ["transaction status", receiptStatus],
          ["txHash", tx.txHash],
          ["attestations", executionOnlyExperiment ? "not present in Anvil" : "等待 validators 对 head/source/target 投票"],
        ],
        note: executionOnlyExperiment
          ? "交易已有 receipt，但没有 Beacon consensus，因此不存在 Ethereum PoS 的 attestation/finality 过程。"
          : "交易已有 receipt，但所在区块仍可能处于 latest，尚未 finalized。",
      },
      operations: [
        {
          title: "导入 latest head",
          detail: "节点把有效区块加入本地 fork-choice view。",
          result: rowValue(tx.finality, "latest"),
        },
        {
          title: "Validators 发 attestation",
          detail: executionOnlyExperiment ? "Anvil 没有 validator committee。" : "委员会对看到的 head 及 checkpoint 投票。",
          result: executionOnlyExperiment ? "not available: execution-only" : "attestation weight accumulates",
        },
        {
          title: "Fork choice 更新 safe",
          detail: executionOnlyExperiment ? "没有 CL fork choice 或 safe head。" : "足够共识权重降低短期 reorg 风险。",
          result: executionOnlyExperiment ? "not available: connect a PoS Beacon API" : rowValue(tx.finality, "safe", rowValue(tx.finality, "justified")),
        },
        {
          title: "Checkpoint finalized",
          detail: executionOnlyExperiment ? "Anvil 没有 checkpoint finality。" : "达到 supermajority link 后，区块及其中交易获得最终性。",
          result: executionOnlyExperiment ? "not available: execution-only" : rowValue(tx.finality, "finalized"),
        },
        {
          title: "提交 canonical state",
          detail: "账户余额、nonce 与合约 storage 作为 canonical chain 状态保留。",
          result: `${tx.diffs?.length || 0} 项状态差异`,
        },
      ],
      output: {
        kind: executionOnlyExperiment ? "LocalExecutionState" : "CanonicalState",
        title: executionOnlyExperiment ? "Anvil 本地状态（无 PoS finality）" : "链上状态与交易确认级别",
        rows: [
          ...(tx.diffs || []).map(([name, , after]) => [name, after]),
          ...(tx.finality || []).map(([name, time]) => [`confirmation.${name}`, time]),
        ],
        note: executionOnlyExperiment
          ? "这是本地执行状态，不代表经过 validators 共识；连接 geth+lighthouse 与 Beacon API 后才能观察完整 PoS 路径。"
          : "最终输出不是一个新 tx，而是被共识认可的区块位置和由交易造成的新状态。",
      },
      explanation: executionOnlyExperiment
        ? "Anvil 只完成交易执行和本地状态提交；完整 blockchain infra 还需要 Consensus Client、Validator Client、attestations 与 finality。"
        : "执行有效只是第一层；attestations 与 checkpoint 共识继续提高确认级别，最终把区块内状态变化固定到 canonical chain。",
    },
  ];

  return models[stage];
}

function renderDataRows(rows = [], columns = 2) {
  return rows
    .map((row) => {
      const cells = row
        .slice(0, columns)
        .map((cell) => `<td><code>${esc(cell)}</code></td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
}

function renderDataKv(title, rows) {
  if (!rows || rows.length === 0) return "";
  return `
    <section class="result-block">
      <h3>${esc(title)}</h3>
      <table class="kv"><tbody>${renderDataRows(rows, 2)}</tbody></table>
    </section>
  `;
}

function renderDataTable(title, headers, rows) {
  if (!rows || rows.length === 0) return "";
  return `
    <section class="result-block">
      <h3>${esc(title)}</h3>
      <div class="table-scroll">
        <table class="wide">
          <thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead>
          <tbody>${renderDataRows(rows, headers.length)}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderDataPool(rows) {
  return renderDataTable(
    "本节点 txpool 快照",
    ["节点", "观察时间", "状态", "Nonce", "说明"],
    rows,
  );
}

function renderDataEvents(events = []) {
  return `
    <section class="result-block">
      <h3>Payload / Beacon 事件</h3>
      <ol class="event-list focused-events">
        ${events
          .map(
            (event) => `
              <li>
                <span class="time">${esc(event[0])}</span>
                <div>
                  <strong>${esc(event[2])}</strong>
                  <p>${esc(event[1])} · ${esc(event[3])}</p>
                </div>
              </li>
            `,
          )
          .join("")}
      </ol>
    </section>
  `;
}

function renderDataFinality(rows = []) {
  return `
    <section class="result-block">
      <h3>确认级别</h3>
      <div class="finality focused-finality">
        ${rows
          .map(
            ([name, time, detail]) => `
              <div class="finality-item">
                <span>${esc(name)}</span>
                <strong>${esc(time)}</strong>
                <small>${esc(detail)}</small>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderIntentEvidence(tx) {
  const scenario = scenarioMeta(tx);
  const rows = [
    ["场景", scenario.title],
    ["from", txField(tx, "from")],
    ["to", txField(tx, "to")],
    ["value", txField(tx, "value", "0")],
    ["input / calldata", txField(tx, "input", "0x")],
  ];
  return `
    ${renderDataKv("Web 准备表达的交易意图", rows)}
    ${renderDataKv("DApp / 合约界面", tx.interface)}
    ${renderDataKv("ABI / calldata 含义", tx.abi)}
    <div class="stage-callout neutral">
      <strong>此刻链上发生了什么？</strong>
      <p>什么都没有。这里只有页面状态和一个待确认的业务动作。</p>
    </div>
  `;
}

function renderConstructEvidence(tx) {
  const def = typeDef();
  const warning = compatibilityLabel(tx, def).startsWith("Incompatible")
    ? `<div class="compat-warning">${esc(compatibilityLabel(tx, def))}</div>`
    : "";
  const fields = activeKey === "live" ? tx.txFields : activityFields(tx, def);
  return `
    <section class="result-block type-lesson">
      <div class="result-block-head">
        <div>
          <h3>选择一种交易 envelope 来理解编码</h3>
          <p>切换只改变教学说明，不会重写已有交易或 Live 记录。</p>
        </div>
        <span class="compact-pill">Type ${esc(activeType)} · ${esc(def.name)}</span>
      </div>
      <div class="type-tabs compact-type-tabs">${renderTypeTabs()}</div>
      ${warning}
    </section>
    ${renderDataKv("交易 envelope", envelopeRows(tx, def))}
    ${renderDataKv("只读预检查 RPC", tx.preflight)}
    ${renderDataKv("准备交给钱包的字段", fields)}
  `;
}

function renderSignEvidence(tx) {
  const def = typeDef();
  return `
    ${renderDataKv("本场景记录到的签名边界", tx.signing)}
    ${renderDataKv("所选 envelope 的签名结构", signingRows(tx, def))}
    <div class="hash-box focused-hash">
      <small>transaction hash</small>
      <code>${esc(tx.txHash)}</code>
    </div>
    <div class="stage-callout neutral">
      <strong>签名不等于发送</strong>
      <p>raw tx 可以先保存在本地。只有下一步提交给 RPC 后，节点才会第一次看到它。</p>
    </div>
  `;
}

function rpcSubmissionRows(tx) {
  const rows = (tx.rpc || []).filter(([method]) => {
    return /sendRawTransaction|sendTransaction|cast send|getTransactionByHash/i.test(method);
  });
  return rows.length ? rows : tx.rpc;
}

function renderRpcEvidence(tx) {
  const rpcExample = JSON.stringify(
    {
      jsonrpc: "2.0",
      method: "eth_sendRawTransaction",
      params: ["<signed raw transaction>"],
      id: 1,
    },
    null,
    2,
  );
  return `
    <section class="result-block rpc-wire">
      <h3>Web / Wallet 发出的 JSON-RPC</h3>
      <pre class="json compact-json">${esc(rpcExample)}</pre>
    </section>
    ${renderDataKv("提交相关 RPC 与返回", rpcSubmissionRows(tx))}
    ${renderDataTable("提交边界", ["参与方", "发生了什么"], renderBroadcastRows(tx).slice(0, 2))}
    <div class="stage-callout warning">
      <strong>拿到 txHash 仍不算上链</strong>
      <p>它只表示 RPC 节点接受了这次提交；交易仍可能等待、被替换、被丢弃或最终执行失败。</p>
    </div>
  `;
}

function renderNodeEvidence(tx) {
  return `
    ${renderDataTable("节点检查与传播", ["环节", "节点动作"], renderBroadcastRows(tx).slice(1, 4))}
    ${renderDataPool(tx.txpool)}
    <div class="stage-callout neutral">
      <strong>pending 与 queued 的区别</strong>
      <p>pending 表示 nonce 连续、当前可执行；queued 常见于前面缺 nonce。每台节点都有自己的观察结果。</p>
    </div>
  `;
}

function proposerDutyRows(tx) {
  return renderValidatorRows(tx).filter(([duty]) => !/attestation/i.test(duty));
}

function attestationRows(tx) {
  return renderValidatorRows(tx).filter(([duty]) => /attestation/i.test(duty));
}

function renderPayloadEvidence(tx) {
  const payloadEvents = (tx.builder || []).filter((event) => event[2] !== "finality_checkpoints");
  return `
    ${renderDataEvents(payloadEvents)}
    ${renderDataTable("Proposer duties", ["职责", "执行者", "具体动作"], proposerDutyRows(tx))}
    <div class="stage-callout neutral">
      <strong>谁真正“打包”？</strong>
      <p>Execution Client 从 txpool 选交易并构建 payload；Consensus Client 组织 Beacon Block；Validator Client 负责签名与提议。</p>
    </div>
  `;
}

function renderExecuteEvidence(tx) {
  return `
    ${renderDataKv("Transaction receipt", tx.receipt)}
    ${renderDataTable("debug_traceTransaction", ["执行步骤", "Gas", "含义"], tx.trace)}
    <div class="stage-callout neutral">
      <strong>status=0 也可能已经上链</strong>
      <p>Revert 会回滚合约内部状态，但交易可以已经被区块收录，sender 的 nonce 与实际 gas 仍会消耗。</p>
    </div>
  `;
}

function renderChainEvidence(tx) {
  return `
    ${renderDataTable("执行前后状态变化", ["状态", "之前", "之后", "原因"], tx.diffs)}
    ${renderDataTable("Attestations 与共识推进", ["职责", "执行者", "具体动作"], attestationRows(tx))}
    ${renderDataFinality(tx.finality)}
    <details class="raw-record">
      <summary>查看完整 Flight Record JSON</summary>
      ${renderJson(recordWithEnvelope(tx, typeDef()))}
    </details>
  `;
}

function renderStageEvidence(tx) {
  return [
    renderIntentEvidence,
    renderConstructEvidence,
    renderSignEvidence,
    renderRpcEvidence,
    renderNodeEvidence,
    renderPayloadEvidence,
    renderExecuteEvidence,
    renderChainEvidence,
  ][stage](tx);
}

function renderArtifactCard(artifact, role) {
  return `
    <article class="artifact-card artifact-${esc(role)}">
      <header>
        <span>${esc(role === "input" ? "INPUT · 进入本步" : "OUTPUT · 离开本步")}</span>
        <em>${esc(artifact.kind)}</em>
      </header>
      <h3>${esc(artifact.title)}</h3>
      <dl class="artifact-fields">
        ${(artifact.rows || [])
          .map(
            ([name, value]) => `
              <div>
                <dt>${esc(name)}</dt>
                <dd><code>${esc(value)}</code></dd>
              </div>
            `,
          )
          .join("")}
      </dl>
      <p class="artifact-note">${esc(artifact.note)}</p>
    </article>
  `;
}

function renderOperationLane(operations) {
  return `
    <section class="operation-lane">
      <header>
        <span>TRANSFORM</span>
        <h3>中间进行了哪些操作</h3>
      </header>
      <ol class="transform-operations">
        ${operations
          .map(
            (operation, index) => `
              <li>
                <span class="operation-index">${index + 1}</span>
                <div>
                  <strong>${esc(operation.title)}</strong>
                  <p>${esc(operation.detail)}</p>
                  <div class="operation-result">
                    <span>产生 / 得到</span>
                    <code>${esc(operation.result)}</code>
                  </div>
                </div>
              </li>
            `,
          )
          .join("")}
      </ol>
    </section>
  `;
}

function renderTransformationBoard(model) {
  return `
    <section class="transformation-board" aria-label="本步骤输入、内部处理与输出">
      ${renderArtifactCard(model.input, "input")}
      ${renderOperationLane(model.operations)}
      ${renderArtifactCard(model.output, "output")}
    </section>
    <div class="transformation-explanation">
      <span>为什么输出会变成这样</span>
      <p>${esc(model.explanation)}</p>
    </div>
  `;
}

function renderJourneySidebar() {
  return `
    <aside class="journey-sidebar">
      <div class="journey-sidebar-head">
        <p class="eyebrow">交易旅程</p>
        <h2>一次只看一步</h2>
        <p>点击步骤，右侧只展示这一段的角色、输入、动作和结果。</p>
      </div>
      <nav class="journey-steps" aria-label="交易执行步骤">
        ${FLOW_STEPS.map((item, index) => {
          const status = index < stage ? "is-done" : index === stage ? "is-current" : "is-upcoming";
          const current = index === stage ? 'aria-current="step"' : "";
          return `
            <button class="journey-step ${status}" data-journey-stage="${index}" ${current}>
              <span class="journey-index">${index + 1}</span>
              <span class="journey-step-copy">
                <strong>${esc(item.label)}</strong>
                <small>${esc(item.detail)}</small>
                <em>${esc(item.actor)}</em>
              </span>
            </button>
          `;
        }).join("")}
      </nav>
    </aside>
  `;
}

function renderJourneyFocus(tx) {
  const item = FLOW_STEPS[stage];
  const evidence = journeyEvidence();
  const scenario = scenarioMeta(tx);
  const model = transformationModel(tx);
  return `
    <article class="journey-focus">
      <header class="journey-focus-head">
        <div class="focus-kicker">
          <span>第 ${stage + 1} / ${FLOW_STEPS.length} 步</span>
          <span class="evidence-badge ${esc(evidence.tone)}">${esc(evidence.label)}</span>
        </div>
        <h2>${esc(item.label)}</h2>
        <p>${esc(item.summary)}</p>
        <div class="artifact-transition" aria-label="输入输出类型">
          <div>
            <small>INPUT TYPE</small>
            <strong>${esc(model.input.kind)}</strong>
          </div>
          <span>经过 ${model.operations.length} 个内部操作 →</span>
          <div>
            <small>OUTPUT TYPE</small>
            <strong>${esc(model.output.kind)}</strong>
          </div>
        </div>
      </header>

      <section class="transformation-shell">
        <div class="transformation-shell-head">
          <div>
            <p class="eyebrow">input → transform → output</p>
            <h2>${esc(scenario.label)} · ${esc(item.label)}</h2>
          </div>
          <span class="compact-pill">${esc(activeKey === "live" ? "Live record" : activeKey === "experiment" ? "Real-time experiment" : "Snapshot")}</span>
        </div>
        ${renderTransformationBoard(model)}
      </section>

      <div class="evidence-note ${esc(evidence.tone)}">
        <strong>这部分数据从哪里来</strong>
        <p>${esc(evidence.note)}</p>
      </div>

      <details class="evidence-drawer" id="step-result">
        <summary>
          <span>展开原始字段与节点记录</span>
          <small>RPC / txpool / receipt / trace / state diff</small>
        </summary>
        <div class="step-result-body">${renderStageEvidence(tx)}</div>
      </details>

      <footer class="focus-nav">
        <button class="control" data-journey-nav="prev" ${stage === 0 ? "disabled" : ""}>← 上一步</button>
        <span>${stage + 1} / ${FLOW_STEPS.length}</span>
        <button class="control primary" data-journey-nav="next" ${stage === FLOW_STEPS.length - 1 ? "disabled" : ""}>下一步 →</button>
      </footer>
    </article>
  `;
}

function renderJourneyFooter() {
  return `
    <section class="devnet journey-devnet">
      <div>
        <p class="eyebrow">观察边界</p>
        <h2>页面是逐步解释器，不是区块链节点</h2>
        <p>Live 会加载已有真实交易记录；当前高容量 RPC snooping 保持关闭。需要完整 Engine API 证据时，应使用短时、受控且有容量上限的抓取。</p>
      </div>
      <code>Web → Wallet → RPC → Execution Node → Txpool → Proposer → EVM → Chain</code>
    </section>
  `;
}

function shortAddress(value) {
  if (!value) return "未连接";
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function renderInfraTrigger() {
  const lab = infraLab.snapshot();
  const rpcReady = lab.rpc.status === "connected";
  const walletReady = lab.wallet.status === "connected";
  const label = rpcReady
    ? `${lab.rpc.chainName}${walletReady ? ` · ${shortAddress(lab.wallet.account)}` : " · 钱包未连"}`
    : "连接 RPC / 钱包";
  const tone = rpcReady && walletReady ? "ready" : rpcReady ? "partial" : "idle";
  return `
    <button class="infra-trigger ${tone}" data-infra-action="toggle" aria-expanded="${lab.open}">
      <span class="infra-dot"></span>
      <span>
        <strong>基础设施实验</strong>
        <small>${esc(label)}</small>
      </span>
    </button>
  `;
}

function renderInfraEvents(experiment) {
  if (!experiment?.events?.length) {
    return `<p class="infra-empty">发送测试交易后，这里会逐条显示 Web、钱包、RPC、txpool、receipt 与 finality 观察。</p>`;
  }
  return `
    <ol class="infra-events">
      ${experiment.events
        .map(
          (event) => `
            <li>
              <span>${esc(event.at)}</span>
              <div>
                <strong>Step ${event.stage + 1} · ${esc(event.action)}</strong>
                <code>${esc(event.result)}</code>
              </div>
            </li>
          `,
        )
        .join("")}
    </ol>
  `;
}

function renderInfraDrawer() {
  const lab = infraLab.snapshot();
  if (!lab.open) return "";
  const rpcReady = lab.rpc.status === "connected";
  const walletReady = lab.wallet.status === "connected";
  const chainMatch = rpcReady && walletReady && lab.rpc.chainId === lab.wallet.chainId;
  const canSend = chainMatch && !lab.busy;
  const walletStatus = walletReady
    ? `${shortAddress(lab.wallet.account)} · chain ${lab.wallet.chainId}`
    : lab.wallet.status === "unavailable"
      ? "未检测到 EIP-1193 钱包"
      : "等待用户授权";
  return `
    <div class="infra-backdrop" data-infra-action="close"></div>
    <aside class="infra-drawer" aria-label="基础设施连接与交易实验">
      <header class="infra-drawer-head">
        <div>
          <p class="eyebrow">infrastructure lab</p>
          <h2>连接真实 RPC 与钱包</h2>
          <p>钱包负责账户授权与签名；Execution RPC 负责节点读写与观察；Beacon API 负责可选的共识上下文。</p>
        </div>
        <button class="drawer-close" data-infra-action="close" aria-label="关闭">×</button>
      </header>

      <div class="infra-drawer-body">
        <section class="infra-boundary-map">
          <div><span>1</span><strong>Browser Wallet</strong><small>账户 + 用户确认 + 签名</small></div>
          <b>→</b>
          <div><span>2</span><strong>Execution RPC</strong><small>tx / txpool / receipt / block</small></div>
          <b>→</b>
          <div><span>3</span><strong>Beacon API</strong><small>head / slot / finality（可选）</small></div>
        </section>

        ${lab.error ? `<div class="infra-message error">${esc(lab.error)}</div>` : ""}
        ${lab.notice ? `<div class="infra-message success">${esc(lab.notice)}</div>` : ""}

        <section class="infra-card">
          <div class="infra-card-head">
            <div><span>01</span><h3>Execution RPC</h3></div>
            <em class="status-${esc(lab.rpc.status)}">${esc(lab.rpc.status)}</em>
          </div>
          <p>请求从你运行浏览器的电脑发出。Remote 模式下，127.0.0.1 指你自己的电脑；请先把远程 RPC 端口转发到本机。URL 只保存在当前页面内存中。</p>
          <p>例如：远程 8545 → 本机 18545，则这里和钱包都填写 http://127.0.0.1:18545。仅转发页面的 8088 端口不会转发 RPC。HTTPS 页面连接 HTTP RPC 时还需检查浏览器的混合内容与本地网络权限提示。</p>
          <div class="infra-presets">
            <button type="button" data-infra-preset="anvil">Local Anvil</button>
            <button type="button" data-infra-preset="pos">Local PoS</button>
            <span>远程测试网请粘贴自己的 RPC URL</span>
          </div>
          <label>
            <span>Execution RPC URL</span>
            <input id="infra-rpc-url" type="url" value="${esc(lab.rpc.url)}" autocomplete="off" spellcheck="false" />
          </label>
          <label>
            <span>Beacon API URL（可选）</span>
            <input id="infra-beacon-url" type="url" value="${esc(lab.rpc.beaconUrl)}" placeholder="http://127.0.0.1:5052" autocomplete="off" spellcheck="false" />
          </label>
          <button class="infra-primary" type="button" data-infra-action="connect-rpc" ${lab.busy ? "disabled" : ""}>
            ${lab.busy === "rpc" ? "连接中…" : rpcReady ? "重新检测 RPC" : "连接并检测 RPC"}
          </button>
          <dl class="infra-status-grid">
            <div><dt>Network</dt><dd>${esc(rpcReady ? lab.rpc.chainName : "-")}</dd></div>
            <div><dt>chainId</dt><dd>${esc(lab.rpc.chainId || "-")}</dd></div>
            <div><dt>Block</dt><dd>${esc(lab.rpc.blockNumber ? `${lab.rpc.blockNumber} / ${hexToDecimal(lab.rpc.blockNumber)}` : "-")}</dd></div>
            <div><dt>Client</dt><dd>${esc(lab.rpc.clientVersion || "-")}</dd></div>
            <div><dt>Beacon</dt><dd>${esc(lab.rpc.beaconStatus)}</dd></div>
            <div><dt>Finalized epoch</dt><dd>${esc(lab.rpc.finalizedEpoch || "-")}</dd></div>
          </dl>
        </section>

        <section class="infra-card">
          <div class="infra-card-head">
            <div><span>02</span><h3>Browser Wallet</h3></div>
            <em class="status-${esc(lab.wallet.status)}">${esc(lab.wallet.status)}</em>
          </div>
          <p>通过 EIP-1193 请求账户和交易确认。本页面不会接收、读取或保存私钥。</p>
          <div class="wallet-summary">
            <strong>${esc(walletStatus)}</strong>
            ${rpcReady && walletReady ? `<small class="${chainMatch ? "match" : "mismatch"}">${chainMatch ? "✓ 钱包与观察 RPC 在同一 chainId" : "⚠ chainId 不一致，禁止发送"}</small>` : ""}
          </div>
          <div class="infra-actions">
            <button class="infra-primary" type="button" data-infra-action="connect-wallet" ${lab.busy ? "disabled" : ""}>
              ${lab.busy === "wallet" ? "等待钱包…" : walletReady ? "重新请求账户" : "连接浏览器钱包"}
            </button>
            ${rpcReady && walletReady && !chainMatch ? `<button type="button" data-infra-action="switch-wallet">切换钱包到 RPC 网络</button>` : ""}
          </div>
        </section>

        <section class="infra-card experiment-card">
          <div class="infra-card-head">
            <div><span>03</span><h3>发送测试交易</h3></div>
            <em>${esc(lab.experiment?.status || "idle")}</em>
          </div>
          <p>支持本机、局域网或私有网络上的 Anvil（31337）/开发网（20230618），以及 Sepolia、Hoodi。钱包确认后，页面通过选定 RPC 观察 txpool、receipt、block 与 finality。</p>
          <label>
            <span>To</span>
            <input id="infra-tx-to" value="${esc(lab.experiment?.to || "0x000000000000000000000000000000000000b0b0")}" autocomplete="off" spellcheck="false" />
          </label>
          <div class="infra-field-row">
            <label>
              <span>Value (ETH)</span>
              <input id="infra-tx-value" inputmode="decimal" value="0.001" />
            </label>
            <label>
              <span>Calldata</span>
              <input id="infra-tx-data" value="0x" autocomplete="off" spellcheck="false" />
            </label>
          </div>
          <button class="infra-primary send" type="button" data-infra-action="send" ${canSend ? "" : "disabled"}>
            ${lab.busy === "transaction" ? "等待钱包确认…" : "构造交易并请求钱包发送"}
          </button>
          <div class="infra-safety-note">
            <strong>观察边界</strong>
            <p>钱包 Provider 负责真实广播；本页选择的 RPC 是独立观察者。只有 chainId 一致，不代表两者是同一台节点。Execution RPC 也看不到内部 Engine API 或 validator 签名。</p>
          </div>
          ${renderInfraEvents(lab.experiment)}
        </section>
      </div>
    </aside>
  `;
}

function renderWalkthrough() {
  const tx = TXS[activeKey];
  const def = typeDef();
  const scenario = scenarioMeta(tx);
  const sourceLabel = activeKey === "live"
    ? "Live · 历史实测"
    : activeKey === "experiment"
      ? "Experiment · 实时观察"
      : "Snapshot · 教学示意";
  app.innerHTML = `
    <header class="topbar">
      <div>
        <strong>Tx Flight Recorder</strong>
        <span>从 Web 发起到上链确认</span>
      </div>
      <div class="topbar-actions">
        <div class="mode-pill">Step ${stage + 1}/${FLOW_STEPS.length} · Type ${esc(activeType)} ${esc(def.name)}</div>
        ${renderInfraTrigger()}
      </div>
    </header>

    ${renderInfraDrawer()}

    <main class="walkthrough-main">
      <section class="walkthrough-intro">
        <div>
          <p class="eyebrow">guided transaction walkthrough</p>
          <h1>${esc(scenario.title)}</h1>
          <p>${esc(scenario.subtitle)}</p>
        </div>
        <div class="source-summary">
          <span>${esc(sourceLabel)}</span>
          <strong>${esc(tx.txHash)}</strong>
          <small>切换左侧步骤时，始终围绕同一个交易场景观察。</small>
        </div>
      </section>

      <section class="scenario-bar">
        <div>
          <small>选择交易场景</small>
          <div class="tabs">${renderJourneyTabs()}</div>
        </div>
        <div class="player">
          <button class="control" data-journey-action="reset">回到第一步</button>
          <button class="control primary" data-journey-action="play">${timer ? "暂停播放" : "自动播放"}</button>
        </div>
      </section>

      <section class="walkthrough-layout">
        ${renderJourneySidebar()}
        ${renderJourneyFocus(tx)}
      </section>

      ${renderJourneyFooter()}
    </main>
  `;
  bindJourneyEvents();
}

function stopJourneyTimer() {
  if (!timer) return;
  window.clearInterval(timer);
  timer = null;
}

function startJourneyTimer() {
  if (timer) {
    stopJourneyTimer();
    renderWalkthrough();
    return;
  }
  if (stage >= FLOW_STEPS.length - 1) stage = 0;
  timer = window.setInterval(() => {
    if (stage >= FLOW_STEPS.length - 1) {
      stopJourneyTimer();
      renderWalkthrough();
      return;
    }
    stage += 1;
    renderWalkthrough();
  }, 1600);
  renderWalkthrough();
}

function bindJourneyEvents() {
  document.querySelectorAll("[data-tx]").forEach((button) => {
    button.addEventListener("click", () => {
      activeKey = button.dataset.tx;
      stage = 0;
      stopJourneyTimer();
      renderWalkthrough();
    });
  });

  document.querySelectorAll("[data-journey-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      stage = Number(button.dataset.journeyStage);
      stopJourneyTimer();
      renderWalkthrough();
    });
  });

  document.querySelectorAll("[data-type]").forEach((button) => {
    button.addEventListener("click", () => {
      activeType = button.dataset.type;
      stopJourneyTimer();
      renderWalkthrough();
    });
  });

  document.querySelectorAll("[data-journey-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.journeyAction === "reset") {
        stage = 0;
        stopJourneyTimer();
        renderWalkthrough();
      } else {
        startJourneyTimer();
      }
    });
  });

  document.querySelectorAll("[data-journey-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      const delta = button.dataset.journeyNav === "next" ? 1 : -1;
      stage = Math.max(0, Math.min(FLOW_STEPS.length - 1, stage + delta));
      stopJourneyTimer();
      renderWalkthrough();
    });
  });

  document.querySelectorAll("[data-infra-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      const rpcInput = document.querySelector("#infra-rpc-url");
      const beaconInput = document.querySelector("#infra-beacon-url");
      if (!rpcInput || !beaconInput) return;
      if (button.dataset.infraPreset === "anvil") {
        rpcInput.value = "http://127.0.0.1:8545";
        beaconInput.value = "";
      } else {
        rpcInput.value = "http://127.0.0.1:8545";
        beaconInput.value = "http://127.0.0.1:5052";
      }
    });
  });

  document.querySelectorAll("[data-infra-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.infraAction;
      if (action === "toggle") {
        infraLab.setOpen(!infraLab.snapshot().open);
      } else if (action === "close") {
        infraLab.setOpen(false);
      } else if (action === "connect-rpc") {
        infraLab.connectRpc({
          rpcUrl: document.querySelector("#infra-rpc-url")?.value || "",
          beaconUrl: document.querySelector("#infra-beacon-url")?.value || "",
        });
      } else if (action === "connect-wallet") {
        infraLab.connectWallet();
      } else if (action === "switch-wallet") {
        infraLab.switchWalletToRpc();
      } else if (action === "send") {
        infraLab.sendExperiment({
          to: document.querySelector("#infra-tx-to")?.value || "",
          valueEth: document.querySelector("#infra-tx-value")?.value || "",
          data: document.querySelector("#infra-tx-data")?.value || "",
        });
      }
    });
  });
}

async function loadLiveRecordWalkthrough() {
  try {
    const response = await fetch(`${LIVE_RECORD_PATH}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return;
    const record = await response.json();
    if (!record?.uiTx?.txHash) return;
    TXS.live = record.uiTx;
    activeKey = "live";
    stage = 0;
    renderWalkthrough();
  } catch {
    // Direct file opens and first-run checkouts usually do not have live output yet.
  }
}

renderWalkthrough();
loadLiveRecordWalkthrough();
