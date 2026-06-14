// Deploy extra ERC-4626 demo vaults on Base Sepolia, branded after real DeFi
// protocols so the co-pilot can allocate across a concrete menu (Aave, Morpho,
// Euler, Moonwell, Fluid, Spark). Each is the same DemoVault(USDC), differing
// only in the protocol it models and the APY the front shows.
//
//   node --env-file=.env ledger/cre/scripts/deploy-vaults.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createWalletClient, createPublicClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.BASE_SEPOLIA_RPC || "https://base-sepolia-rpc.publicnode.com";
const USDC = getAddress(process.env.DEMO_TOKEN || "0x036CbD53842c5426634e7929541eC2318f3dCF7e");

const pk = (process.env.FUNDING_PRIVATE_KEY || "").replace(/^0x/, "");
if (!pk) throw new Error("FUNDING_PRIVATE_KEY missing (run with --env-file=.env)");
const account = privateKeyToAccount(`0x${pk}`);
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

const sol = JSON.parse(readFileSync(join(HERE, "..", "..", "contracts", "DemoVault.json"), "utf8"));
const c = sol.contracts["DemoVault.sol:DemoVault"];
const abi = typeof c.abi === "string" ? JSON.parse(c.abi) : c.abi;
const bytecode = `0x${c.bin}`;

// The new vaults to deploy (the existing Aave + Morpho stay as-is).
const NEW = [
  { name: "Euler USDC", protocol: "Euler", apy: 6.9, risk: "high" },
  { name: "Moonwell USDC", protocol: "Moonwell", apy: 5.5, risk: "medium" },
  { name: "Fluid USDC", protocol: "Fluid", apy: 6.3, risk: "medium" },
  { name: "Spark USDC", protocol: "Spark", apy: 4.8, risk: "low" },
];

const out = [];
for (const v of NEW) {
  const hash = await wallet.deployContract({ abi, bytecode, args: [USDC] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${v.name.padEnd(14)} @ ${rc.contractAddress}  (${v.protocol}, ~${v.apy}%, ${v.risk})`);
  out.push({ ...v, address: rc.contractAddress });
}
console.log("\nVAULTS entries:");
for (const v of out) console.log(`  { address: "${v.address.toLowerCase()}", name: "${v.name}", protocol: "${v.protocol}", apy: ${v.apy}, risk: "${v.risk}" },`);
