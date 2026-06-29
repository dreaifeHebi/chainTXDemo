const STAGES = [
  { id: "draft", label: "Construct", detail: "fields + fee + gas" },
  { id: "signed", label: "Sign", detail: "hash + signature + raw tx" },
  { id: "accepted", label: "RPC accepted", detail: "sendRawTransaction" },
  { id: "pool", label: "Txpool", detail: "pending / queued" },
  { id: "payload", label: "Payload", detail: "engine API + proposer" },
  { id: "executed", label: "Executed", detail: "receipt + trace" },
  { id: "state", label: "State", detail: "diff + finality" },
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
let stage = 6;
let timer = null;

const app = document.querySelector("#app");

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function rowClass(itemStage) {
  if (itemStage < stage) return "ready";
  if (itemStage === stage) return "current";
  return "waiting";
}

function renderRows(rows, columns) {
  return rows
    .map((row) => {
      const itemStage = row[row.length - 1];
      const cells = row
        .slice(0, columns)
        .map((cell) => `<td><code>${esc(cell)}</code></td>`)
        .join("");
      return `<tr class="${rowClass(itemStage)}">${cells}</tr>`;
    })
    .join("");
}

function renderKv(title, rows) {
  return `
    <div class="module">
      <h3>${esc(title)}</h3>
      <table class="kv">
        <tbody>${renderRows(rows, 2)}</tbody>
      </table>
    </div>
  `;
}

function renderOptionalKv(title, rows) {
  if (!rows || rows.length === 0) return "";
  return renderKv(title, rows);
}

function renderBroadcastRows(tx) {
  return tx.broadcast || [
    ["local signer", "serialized raw transaction bytes are produced before RPC sees anything", 1],
    ["Node A RPC", "eth_sendRawTransaction validates envelope, signature, nonce, fee cap, and intrinsic gas", 2],
    ["local txpool", "pending if executable now, queued if the sender nonce has a gap", 3],
    ["EL P2P gossip", "Node A announces the transaction and Node B imports it into its txpool", 3],
    ["payload boundary", "validator never executes Solidity directly; CL asks EL to build an execution payload", 4],
  ];
}

function renderValidatorRows(tx) {
  return tx.validator || [
    ["slot duty", "Beacon state maps the slot to a proposer index", "validator client prepares a block proposal request", 4],
    ["payload attributes", "Consensus client sends engine_forkchoiceUpdated", "execution client starts building a payload on the current head", 4],
    ["tx selection", "Execution client pulls profitable valid txs from txpool", "payload ordering is checked by nonce, gas, and block gas limit", 4],
    ["block proposal", "validator signs the beacon block", "execution payload is embedded in the beacon block body", 4],
    ["attestation", "other validators vote for the head", "safe/finalized status comes later than the transaction receipt", 6],
  ];
}

function renderSimpleTable(title, headers, rows) {
  if (!rows || rows.length === 0) return "";
  return `
    <div class="module">
      <h3>${esc(title)}</h3>
      <table class="wide">
        <thead>
          <tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr>
        </thead>
        <tbody>${renderRows(rows, headers.length)}</tbody>
      </table>
    </div>
  `;
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

function renderTypeStrip(tx) {
  const def = typeDef();
  const warning = compatibilityLabel(tx, def).startsWith("Incompatible")
    ? `<div class="compat-warning">${esc(compatibilityLabel(tx, def))}</div>`
    : "";
  return `
    <section class="type-strip">
      <div class="type-copy">
        <p class="eyebrow">transaction envelope</p>
        <h2>Type 0-4 format switch</h2>
        <p>${esc(def.envelope)}</p>
      </div>
      <div class="type-tabs">${renderTypeTabs()}</div>
      ${warning}
    </section>
  `;
}

function renderEventList(events) {
  return `
    <ol class="event-list">
      ${events
        .map((event) => {
          const itemStage = event[4];
          return `
            <li class="${rowClass(itemStage)}">
              <span class="time">${esc(event[0])}</span>
              <div>
                <strong>${esc(event[2])}</strong>
                <p>${esc(event[1])} - ${esc(event[3])}</p>
              </div>
            </li>
          `;
        })
        .join("")}
    </ol>
  `;
}

function renderTrace(trace) {
  return `
    <table class="trace">
      <thead>
        <tr><th>Step</th><th>Gas</th><th>Meaning</th></tr>
      </thead>
      <tbody>${renderRows(trace, 3)}</tbody>
    </table>
  `;
}

function renderDiffs(diffs) {
  return `
    <table class="diff">
      <thead>
        <tr><th>State</th><th>Before</th><th>After</th><th>Why</th></tr>
      </thead>
      <tbody>${renderRows(diffs, 4)}</tbody>
    </table>
  `;
}

function renderPool(rows) {
  return `
    <table class="pool">
      <thead>
        <tr><th>Node</th><th>Seen</th><th>Status</th><th>Nonce</th><th>Note</th></tr>
      </thead>
      <tbody>${renderRows(rows, 5)}</tbody>
    </table>
  `;
}

function renderFinality(rows) {
  return `
    <div class="finality">
      ${rows
        .map((row) => {
          const [name, time, detail, itemStage] = row;
          return `
            <div class="finality-item ${rowClass(itemStage)}">
              <span>${esc(name)}</span>
              <strong>${esc(time)}</strong>
              <small>${esc(detail)}</small>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderJson(record) {
  return `<pre class="json">${esc(JSON.stringify(record, null, 2))}</pre>`;
}

function renderTabs() {
  return Object.entries(TXS)
    .map(([key, tx]) => {
      const selected = key === activeKey ? "selected" : "";
      return `<button class="tab ${selected}" data-tx="${esc(key)}">${esc(tx.label)}</button>`;
    })
    .join("");
}

function renderStageControls() {
  return STAGES.map((item, index) => {
    const selected = index === stage ? "selected" : "";
    const done = index < stage ? "done" : "";
    return `
      <button class="stage ${selected} ${done}" data-stage="${index}">
        <span>${index + 1}</span>
        <strong>${esc(item.label)}</strong>
        <small>${esc(item.detail)}</small>
      </button>
    `;
  }).join("");
}

function topologyStatus(index) {
  if (stage > index) return "ready";
  if (stage === index) return "current";
  return "waiting";
}

function renderTopology(tx) {
  const nodes = [
    ["Signer", "local script", 1],
    ["Node A", "RPC + txpool + EL", 2],
    ["Node B", "EL P2P observer", 3],
    ["Beacon", "fork choice + payload", 4],
    ["Validator", "proposer / attester", 4],
    ["Chain", "latest -> safe -> finalized", 6],
  ];

  return `
    <section class="topology">
      <div class="topology-copy">
        <p class="eyebrow">local PoS devnet trace</p>
        <h1>${esc(tx.title)}</h1>
        <p>${esc(tx.subtitle)}</p>
      </div>
      <div class="node-map">
        ${nodes
          .map(([name, detail, gate], index) => {
            const arrow = index < nodes.length - 1 ? `<span class="edge"></span>` : "";
            return `
              <div class="node-wrap">
                <div class="node ${topologyStatus(gate)}">
                  <strong>${esc(name)}</strong>
                  <small>${esc(detail)}</small>
                </div>
                ${arrow}
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderPanels(tx) {
  const def = typeDef();
  return `
    <section class="panes">
      <article class="panel">
        <div class="panel-head">
          <span>01</span>
          <h2>Raw Tx</h2>
        </div>
        ${renderKv("Envelope format", envelopeRows(tx, def))}
        ${renderOptionalKv("DApp / contract interface", tx.interface)}
        ${renderOptionalKv("ABI / calldata", tx.abi)}
        ${renderKv("Preflight RPC", tx.preflight)}
        ${renderKv("Active fields", activityFields(tx, def))}
        ${renderKv("Local signing", signingRows(tx, def))}
        <div class="hash-box ${rowClass(1)}">
          <small>transaction hash</small>
          <code>${esc(tx.txHash)}</code>
        </div>
      </article>

      <article class="panel">
        <div class="panel-head">
          <span>02</span>
          <h2>RPC / Txpool</h2>
        </div>
        ${renderKv("RPC calls", tx.rpc)}
        ${renderKv("Broadcast path", renderBroadcastRows(tx))}
        <div class="module">
          <h3>txpool_contentFrom(sender)</h3>
          ${renderPool(tx.txpool)}
        </div>
      </article>

      <article class="panel">
        <div class="panel-head">
          <span>03</span>
          <h2>Block Builder</h2>
        </div>
        <div class="module">
          <h3>Engine API snooper</h3>
          ${renderEventList(tx.builder)}
        </div>
        ${renderSimpleTable("Validator duties", ["Duty", "Actor", "Detail"], renderValidatorRows(tx))}
        <div class="beacon-card ${rowClass(4)}">
          <span>slot cadence</span>
          <strong>4 seconds</strong>
          <small>CL chooses the head; EL builds and validates the execution payload.</small>
        </div>
      </article>

      <article class="panel">
        <div class="panel-head">
          <span>04</span>
          <h2>EVM Execution</h2>
        </div>
        <div class="module">
          <h3>Receipt</h3>
          <table class="kv">
            <tbody>${renderRows(tx.receipt, 2)}</tbody>
          </table>
        </div>
        <div class="module">
          <h3>debug_traceTransaction</h3>
          ${renderTrace(tx.trace)}
        </div>
      </article>

      <article class="panel">
        <div class="panel-head">
          <span>05</span>
          <h2>Chain State</h2>
        </div>
        <div class="module">
          <h3>Before / after diff</h3>
          ${renderDiffs(tx.diffs)}
        </div>
        <div class="module">
          <h3>Consensus status</h3>
          ${renderFinality(tx.finality)}
        </div>
        <div class="module">
          <h3>Flight record</h3>
          ${renderJson(recordWithEnvelope(tx, def))}
        </div>
      </article>
    </section>
  `;
}

function renderFooter() {
  return `
    <section class="devnet">
      <div>
        <p class="eyebrow">devnet wiring</p>
        <h2>Real-node path is already mapped</h2>
        <p>Use the included Kurtosis params to start geth + lighthouse nodes with RPC snooper enabled, then replace the snapshot rows with live JSON-RPC, txpool, Beacon API, and snooper events.</p>
      </div>
      <code>kurtosis run --enclave tx-flight-recorder github.com/ethpandaops/ethereum-package --args-file network_params.yaml</code>
    </section>
  `;
}

function render() {
  const tx = TXS[activeKey];
  const def = typeDef();
  app.innerHTML = `
    <header class="topbar">
      <div>
        <strong>Tx Flight Recorder</strong>
        <span>RPC / txpool / Engine API / validator / state</span>
      </div>
      <div class="mode-pill">snapshot | Type ${esc(activeType)} ${esc(def.name)}</div>
    </header>

    <main>
      ${renderTopology(tx)}

      <section class="controls">
        <div class="tabs">${renderTabs()}</div>
        <div class="player">
          <button class="control" data-action="reset">Reset</button>
          <button class="control primary" data-action="play">${timer ? "Pause" : "Play"}</button>
        </div>
      </section>

      ${renderTypeStrip(tx)}

      <section class="stagebar">${renderStageControls()}</section>

      ${renderPanels(tx)}
      ${renderFooter()}
    </main>
  `;

  bindEvents();
}

function bindEvents() {
  document.querySelectorAll("[data-tx]").forEach((button) => {
    button.addEventListener("click", () => {
      activeKey = button.dataset.tx;
      stage = 6;
      stopTimer();
      render();
    });
  });

  document.querySelectorAll("[data-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      stage = Number(button.dataset.stage);
      stopTimer();
      render();
    });
  });

  document.querySelectorAll("[data-type]").forEach((button) => {
    button.addEventListener("click", () => {
      activeType = button.dataset.type;
      stopTimer();
      render();
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.action === "reset") {
        stage = 0;
        stopTimer();
        render();
      }
      if (button.dataset.action === "play") {
        if (timer) {
          stopTimer();
          render();
        } else {
          stage = 0;
          timer = window.setInterval(() => {
            stage += 1;
            if (stage >= STAGES.length - 1) {
              stage = STAGES.length - 1;
              stopTimer();
            }
            render();
          }, 950);
          render();
        }
      }
    });
  });
}

function stopTimer() {
  if (timer) {
    window.clearInterval(timer);
    timer = null;
  }
}

render();
