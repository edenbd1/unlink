// One-command Chainlink demo: confidential inference -> CRE workflow simulation
// -> on-chain attestation -> the Execution Account's enforced gate read.
//
//   npm run demo:chainlink
//
// Runs the whole pipeline end-to-end and prints a clean narrative. Uses the local
// Confidential AI Attester stand-in (or the real sandbox if CONFIDENTIAL_AI_API_KEY
// is set) and the AllocationGate already deployed on Base Sepolia.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createWalletClient, createPublicClient, http, getAddress, keccak256,
  encodeAbiParameters, parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { submitLocalInference, getLocalInference } from "../../host/local-attester.mjs";
import { runConfidentialInference, attesterMode } from "../../host/confidential-ai.mjs";
import { readAttestedAllocation } from "../../host/allocation-gate.mjs";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CRE_DIR = join(HERE, "..");
const CALLBACK = join(CRE_DIR, "simulation", "demo-callback.json");
const RPC = process.env.BASE_SEPOLIA_RPC || "https://base-sepolia-rpc.publicnode.com";
const GATE = process.env.ALLOCATION_GATE || "0xaf73bc5f7e53f58502443af04756e175278ffcf1";
const USER = process.env.LEDGER_ETH_ADDRESS || "0x065dF3372c1f9f86f5cfC220db027da2A754fdbF";
const ALLOCATION_ABI = "address user, address[] vaults, uint16[] bps, uint16 blendedApyBps, bool approved, bytes32 transcriptHash, string inferenceId";

const VAULTS = [
  { address: "0xedf18f946344395d9fc5e20a67289ccce3f25b6f", name: "Aave USDC", protocol: "Aave v3", apy: 4.1, risk: "low" },
  { address: "0xe7c683e76b3a99d32cbda67beb33eedacaf6f90f", name: "Morpho USDC", protocol: "Morpho", apy: 7.4, risk: "high" },
];
const GOALS = process.argv[2] || "$10,000 steady yield, not too aggressive, good APY";
const hr = (t) => console.log(`\n\x1b[1m\x1b[36m${t}\x1b[0m`);

// Run a local inference directly (in-process) and return the full callback object.
async function localInference() {
  const system =
    "You are an autonomous DeFi yield strategist analysing a private profile in a TEE. " +
    "Reply ONLY JSON {approved,risk_level,blended_apy_bps,reason,allocations:[{vault,name,bps}]}, bps sum 10000, only the given vault addresses.";
  const prompt =
    `Private profile: goals="${GOALS}"; capital 10000 USDC; Unlink balance 10000 USDC.\nVaults: ` +
    VAULTS.map((v) => `${v.name} ${v.address} ~${v.apy}% ${v.risk}`).join("; ");
  const { id } = submitLocalInference({ model: "gemma4", system_prompt: system, prompt });
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = getLocalInference(id);
    if (j.status === "completed") return j;
    if (j.status === "failed") throw new Error("inference failed");
  }
  throw new Error("inference timed out");
}

async function main() {
  console.log("\x1b[1mLunave — Chainlink Confidential AI + CRE demo\x1b[0m");
  console.log(`goals: "${GOALS}"`);

  // 1) Confidential inference
  hr("1 · Confidential AI inference  (private profile -> allocation)");
  const mode = attesterMode();
  let callback;
  if (mode === "real") {
    console.log("attester: REAL sandbox (TEE)");
    const inf = await runConfidentialInference({ goals: GOALS, capitalBase: "10000000", balanceBase: "10000000", vaults: VAULTS });
    // rebuild a callback object from the host result for the workflow
    callback = { id: inf.inferenceId, status: "completed", model: inf.model, output: inf.raw.output,
      resources: [{ digest: inf.digests.content, request_digest: inf.digests.request, response_digest: inf.digests.response }] };
  } else {
    console.log("attester: LOCAL stand-in (Mistral, no TEE) — set CONFIDENTIAL_AI_API_KEY for the real sandbox");
    callback = await localInference();
  }
  writeFileSync(CALLBACK, JSON.stringify(callback, null, 2));
  const dec = JSON.parse(callback.output.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? callback.output);
  console.log(`inference id: ${callback.id}`);
  console.log(`decision: approved=${dec.approved} risk=${dec.risk_level} blended=${(dec.blended_apy_bps / 100).toFixed(2)}%`);
  dec.allocations.forEach((a) => console.log(`  ${a.bps / 100}%  ${a.name}  ${a.vault}`));
  console.log(`response_digest (provenance): 0x${callback.resources[0].response_digest}`);

  // 2) CRE workflow simulation
  hr("2 · CRE workflow simulation  (binds the digest, encodes the report)");
  try {
    const cre = join(process.env.HOME, ".cre", "bin", "cre");
    const { stdout } = await execFileP(cre, [
      "workflow", "simulate", "yield-allocation-workflow", "--target", "staging-settings",
      "--non-interactive", "--trigger-index", "0", "--http-payload", CALLBACK,
    ], { cwd: CRE_DIR, maxBuffer: 1 << 22 });
    stdout.split("\n").filter((l) => /USER LOG|Simulation Result|Workflow compiled|Simulation complete/.test(l))
      .forEach((l) => console.log("  " + l.replace(/^\d{4}-.*?\]\s*/, "").trim()));
  } catch (e) {
    console.log("  (CRE simulate skipped — run `cre login` first. Error: " + String(e.message || e).split("\n")[0] + ")");
  }

  // 3) On-chain attestation (deliver the report through the gate)
  hr("3 · On-chain attestation  (writeReport -> AllocationGate, Base Sepolia)");
  const pk = (process.env.FUNDING_PRIVATE_KEY || "").replace(/^0x/, "");
  if (pk) {
    const account = privateKeyToAccount(`0x${pk}`);
    const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
    const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
    const artifact = JSON.parse(readFileSync(join(CRE_DIR, "out", "AllocationGate.sol", "AllocationGate.json"), "utf8"));
    const entries = dec.allocations.filter((a) => a.vault && a.bps > 0);
    const vaults = entries.map((a) => getAddress(a.vault));
    const bps = entries.map((a) => Math.round(Number(a.bps)));
    const transcriptHash = `0x${callback.resources[0].response_digest}`;
    const report = encodeAbiParameters(parseAbiParameters(ALLOCATION_ABI),
      [getAddress(USER), vaults, bps, Math.round(dec.blended_apy_bps), dec.approved === true, transcriptHash, callback.id]);
    const tx = await wallet.writeContract({ address: getAddress(GATE), abi: artifact.abi, functionName: "onReport", args: ["0x", report] });
    await pub.waitForTransactionReceipt({ hash: tx });
    console.log(`  delivered (as the forwarder stand-in): https://sepolia.basescan.org/tx/${tx}`);
  } else {
    console.log("  (skipped — FUNDING_PRIVATE_KEY not set)");
  }

  // 4) The Execution Account's enforced gate read
  hr("4 · Execution Account reads the gate  (only acts within the attested set)");
  const a = await readAttestedAllocation(USER);
  if (a && a.approved) {
    console.log(`  AllocationGate ${a.gate}`);
    console.log(`  approved=${a.approved}  blended=${(a.blendedApyBps / 100).toFixed(2)}%`);
    a.allocations.forEach((x) => console.log(`  ${x.bps / 100}%  ${x.vault}`));
    console.log(`  transcriptHash=${a.transcriptHash}`);
  } else {
    console.log("  no attested allocation on-chain yet");
  }

  hr("Pipeline complete");
  console.log("private profile -> Confidential AI inference -> CRE workflow (DON report) ->");
  console.log("AllocationGate on Base Sepolia -> the Ledger-custodied agent acts only within it.");
  console.log(`\nGate: https://sepolia.basescan.org/address/${GATE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
