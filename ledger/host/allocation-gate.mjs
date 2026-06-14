// Read the DON-attested allocation from AllocationGate on Base Sepolia.
//
// This is the Execution Account's view: before the agent deploys or rebalances,
// it reads approvedAllocation(user) and stays within the attested vault set +
// weights. Turns the Confidential AI attestation from a side artifact into an
// enforced on-chain gate.
import { createPublicClient, createWalletClient, http, getAddress, keccak256, encodeAbiParameters, parseAbiParameters, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC = process.env.BASE_SEPOLIA_RPC || "https://base-sepolia-rpc.publicnode.com";
const GATE = process.env.ALLOCATION_GATE || "0xaf73bc5f7e53f58502443af04756e175278ffcf1";
const ALLOCATION_ABI = "address user, address[] vaults, uint16[] bps, uint16 blendedApyBps, bool approved, bytes32 transcriptHash, string inferenceId";
const ONREPORT_ABI = [{ type: "function", stateMutability: "nonpayable", name: "onReport", inputs: [{ name: "metadata", type: "bytes" }, { name: "report", type: "bytes" }], outputs: [] }];

const ABI = [
  { type: "function", stateMutability: "view", name: "approvedAllocation",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "approved", type: "bool" }, { name: "vaults", type: "address[]" },
      { name: "bps", type: "uint16[]" }, { name: "blendedApyBps", type: "uint16" },
      { name: "transcriptHash", type: "bytes32" },
    ] },
  { type: "function", stateMutability: "view", name: "isApproved",
    inputs: [{ name: "user", type: "address" }], outputs: [{ type: "bool" }] },
];

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

export function allocationGateAddress() { return GATE; }

// Returns the attested allocation for `user`, or { approved:false, vaults:[] } if
// none. Never throws — a read failure returns null so callers can degrade.
export async function readAttestedAllocation(user) {
  try {
    const u = getAddress(user);
    const [approved, vaults, bps, blendedApyBps, transcriptHash] = await pub.readContract({
      address: getAddress(GATE), abi: ABI, functionName: "approvedAllocation", args: [u],
    });
    return {
      gate: GATE, user: u, approved, transcriptHash,
      blendedApyBps: Number(blendedApyBps),
      allocations: vaults.map((v, i) => ({ vault: getAddress(v), bps: Number(bps[i]) })),
    };
  } catch {
    return null;
  }
}

// Write the deployed allocation to the gate, so on-chain reflects what was
// actually deployed and the agent can rebalance within it. Uses the funding
// wallet as the forwarder stand-in (the gate was deployed with it as forwarder).
// On the live CRE path this write is the DON's writeReport instead. Best-effort:
// returns the tx hash, or null if no funding key / it fails.
export async function writeAttestedAllocation({ user, allocations, blendedApyBps, transcriptHash, inferenceId }) {
  const pk = (process.env.FUNDING_PRIVATE_KEY || "").replace(/^0x/, "");
  if (!pk || !allocations?.length) return null;
  try {
    const account = privateKeyToAccount(`0x${pk}`);
    const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
    const vaults = allocations.map((a) => getAddress(a.vault));
    const bps = allocations.map((a) => Math.round(Number(a.bps)));
    const th = transcriptHash && /^0x[0-9a-f]{64}$/i.test(transcriptHash) ? transcriptHash : keccak256(toBytes(inferenceId || "lunave"));
    const report = encodeAbiParameters(parseAbiParameters(ALLOCATION_ABI),
      [getAddress(user), vaults, bps, Math.round(Number(blendedApyBps) || 0), true, th, String(inferenceId || "")]);
    return await wallet.writeContract({ address: getAddress(GATE), abi: ONREPORT_ABI, functionName: "onReport", args: ["0x", report] });
  } catch { return null; }
}

// Is `vault` inside the user's attested allocation? Used to gate a rebalance.
export async function isVaultAttested(user, vault) {
  const a = await readAttestedAllocation(user);
  if (!a || !a.approved || !a.allocations.length) return { attested: false, allocation: a };
  const v = getAddress(vault);
  return { attested: a.allocations.some((x) => x.vault === v), allocation: a };
}
