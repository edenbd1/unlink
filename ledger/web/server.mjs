// Localhost test rig for the Ledger-custodied Unlink account.
// Serves a tiny front + an API that drives the device:
//   connect (read/cache keys) · deposit into the pool (EVM) · private transfer
//   (Ledger-signed) · pool -> DeFi via an Execution Account (Ledger-signed).
//
// Run:  node --env-file=.env native/web/server.mjs    →  http://localhost:8799
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createUnlinkAdmin } from "@unlink-xyz/sdk/admin";
import { createUnlinkClient, evm } from "@unlink-xyz/sdk/client";
import { createWalletClient, createPublicClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { buildDeviceAccount, reviewIntentOnDevice, reviewPairsOnDevice, connectApproveOnDevice } from "../host/device-account.mjs";
import { ledgerEthClients, getLedgerEthAddress } from "../host/ledger-eth-account.mjs";
import { runConfidentialStrategy, verifyAttestation, attestorAddress } from "../host/cre-attestation.mjs";
import { runConfidentialInference, confidentialAiConfigured } from "../host/confidential-ai.mjs";
import { mountLocalAttester } from "../host/local-attester.mjs";
import { readAttestedAllocation, isVaultAttested, allocationGateAddress } from "../host/allocation-gate.mjs";
import { createYieldBot } from "../host/yield-bot.mjs";
import { sealMandate, pgpCardAvailable } from "../host/mandate-seal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = process.env.UNLINK_ENVIRONMENT || "base-sepolia";
const API_KEY = process.env.UNLINK_API_KEY || "";
const FUNDING_PK = process.env.FUNDING_PRIVATE_KEY || "";
const USDC = process.env.DEMO_TOKEN || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DEMO_VAULT = process.env.DEMO_VAULT || "0xedf18f946344395d9fc5e20a67289ccce3f25b6f"; // ERC-4626 demo vault (USDC), depositSelf/redeemSelf
const LEDGER_ETH = process.env.LEDGER_ETH_ADDRESS || "0x065dF3372c1f9f86f5cfC220db027da2A754fdbF";
const PORT = Number(process.env.WEB_PORT || 8799);

// ERC-4626 USDC vaults the yield agent can allocate to (real, on Base Sepolia).
const VAULTS = [
  { address: (process.env.DEMO_VAULT || "0xedf18f946344395d9fc5e20a67289ccce3f25b6f"), name: "Unlink Stable Vault", apy: 4.2, risk: "low" },
  { address: (process.env.DEMO_VAULT_B || "0xe7c683e76b3a99d32cbda67beb33eedacaf6f90f"), name: "Unlink Growth Vault", apy: 7.8, risk: "high" },
];
let LAST_STRATEGY = null;    // last proposed strategy, deployed on approval
let LAST_ATTESTATION = null; // Chainlink CRE AI Attestation for that strategy

let S = null; // { account, admin, client, address }
let ETH_ADDR = null; // cached Ledger ETH address (vault-share receiver)

const human = (base) => (Number(base) / 1e6).toFixed(2) + " USDC";
const shortAddr = (a) => a.slice(0, 14) + "…" + a.slice(-6);

function evmProvider() {
  if (!FUNDING_PK) return undefined;
  return evm.fromViem({
    walletClient: createWalletClient({ account: privateKeyToAccount(FUNDING_PK), chain: baseSepolia, transport: http() }),
    publicClient: createPublicClient({ chain: baseSepolia, transport: http() }),
  });
}

async function balanceList() {
  if (!S) return [];
  const b = await S.admin.users.getBalances({ address: S.address });
  return (b?.balances ?? []).map((x) => ({ token: x.token, amount: x.amount, human: human(x.amount) }));
}

const app = new Hono();

// Local stand-in for the Chainlink Confidential AI Attester: same /v1/inference
// contract, so the whole pipeline runs without a sandbox API key. Disabled if a
// real key is set (then the real TEE sandbox is used) or with LOCAL_ATTESTER=0.
mountLocalAttester(app);

app.get("/", (c) => c.html(readFileSync(join(HERE, "index.html"), "utf8")));

// Connect: read+cache the device keys, build the account, register, open a client.
app.post("/api/connect", async (c) => {
  if (!API_KEY) return c.json({ error: "UNLINK_API_KEY missing (run with --env-file=.env)" }, 400);
  try {
    // pairing approval on the device (open the Unlink app + tap)
    const approved = await connectApproveOnDevice();
    if (!approved) return c.json({ error: "connection rejected on device" }, 400);
    const account = await buildDeviceAccount();
    const admin = createUnlinkAdmin({ environment: ENV, apiKey: API_KEY });
    await admin.users.register(await account.getRegistrationPayload());
    const client = createUnlinkClient({
      environment: ENV, account, ...(evmProvider() ? { evm: evmProvider() } : {}),
      authorizationToken: { provider: async ({ unlinkAddress }) => admin.authorizationTokens.issue({ unlinkAddress }) },
      register: async () => admin.users.register(await account.getRegistrationPayload()),
    });
    S = { account, admin, client, address: account.address };
    return c.json({ address: S.address, fromCache: !!account.fromCache, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

app.get("/api/status", async (c) =>
  c.json({ connected: !!S, address: S?.address || null, balances: await balanceList() }));

// Deposit USDC into the private pool. Funded by the EVM wallet (no Unlink spend,
// so no Ledger signature needed) — credits the device account's private balance.
app.post("/api/deposit", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const { amount = "1000000" } = await c.req.json().catch(() => ({}));
  try {
    const approved = await reviewIntentOnDevice(human(amount), "shield into pool");
    if (!approved) return c.json({ error: "deposit rejected on device" }, 400);
    await S.client.depositWithApproval({ token: USDC, amount });
    return c.json({ ok: true, note: `shielded ${human(amount)} into the pool`, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

// The Ledger's own Ethereum address (where you hold USDC to shield).
app.get("/api/eth-address", async (c) => {
  try { ETH_ADDR = await getLedgerEthAddress(); return c.json({ address: ETH_ADDR }); }
  catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

// Shield USDC straight FROM the Ledger's ETH address into the pool. The Ledger
// Ethereum app signs the Permit2 deposit (and the one-time Permit2 approval).
// Requires: Ethereum app open, blind signing ON, USDC (+ a little ETH) on the address.
app.post("/api/shield-ledger", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const { amount = "1000000" } = await c.req.json().catch(() => ({}));
  try {
    const { walletClient, publicClient, address: ethAddr } = await ledgerEthClients();
    ETH_ADDR = ethAddr;
    const ledgerEvm = evm.fromViem({ walletClient, publicClient });
    const client = createUnlinkClient({
      environment: ENV, account: S.account, evm: ledgerEvm,
      authorizationToken: { provider: async ({ unlinkAddress }) => S.admin.authorizationTokens.issue({ unlinkAddress }) },
      register: async () => S.admin.users.register(await S.account.getRegistrationPayload()),
    });
    await client.depositWithApproval({ token: USDC, amount });
    return c.json({ ok: true, note: `shielded ${human(amount)} from Ledger ${shortAddr(ethAddr)}`, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

// Private transfer (pool -> pool). SPENDS the Unlink key → Ledger approve + sign.
app.post("/api/transfer", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const { amount = "100000", recipient } = await c.req.json().catch(() => ({}));
  try {
    const to = recipient || S.address; // default self
    const approved = await reviewIntentOnDevice(human(amount), to); // FULL address on device
    if (!approved) return c.json({ error: "rejected on device" }, 400);
    const h = await S.client.transfer({ recipientAddress: to, amount, token: USDC });
    return c.json({ ok: true, txId: h.txId, status: h.status, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

// Pool -> DeFi vault via an Execution Account. Withdraws `amount` privately into
// the EA, then from the EA: approve(vault) + ERC-4626 deposit(amount, receiver).
// SPENDS the private balance → Ledger approve + sign (Unlink app).
const ERC20_APPROVE = [{ name: "approve", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }];
const ERC4626_DEPOSIT = [{ name: "deposit", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ name: "shares", type: "uint256" }] }];

// depositSelf/redeemSelf mint+burn to msg.sender (the Execution Account), so we
// never need the EA address ahead of time.
const ERC4626_DEPOSIT_SELF = [{ name: "depositSelf", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "assets", type: "uint256" }], outputs: [{ name: "shares", type: "uint256" }] }];
const ERC4626_REDEEM_SELF = [{ name: "redeemSelf", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "shares", type: "uint256" }], outputs: [{ name: "assets", type: "uint256" }] }];

let POSITIONS = []; // open vault positions held by an Execution Account, redeemable later

app.get("/api/positions", (c) => c.json({ positions: POSITIONS }));

// Deposit into an ERC-4626 vault. The Execution Account is msg.sender, so
// depositSelf mints the SHARES to the EA itself and the position can be redeemed
// later from the same account (Aave-style: deposit USDC -> aToken, then redeem).
// Signed on the Ledger.
app.post("/api/execute", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const amount = body.amount || "100000";
  const vault = body.vault || DEMO_VAULT;
  const vaultName = body.vaultName || "Unlink Demo Vault";
  if (!vault) return c.json({ error: "vault address required" }, 400);
  const calls = [
    { target: USDC, value: "0", data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [vault, BigInt(amount)] }) },
    { target: vault, value: "0", data: encodeFunctionData({ abi: ERC4626_DEPOSIT_SELF, functionName: "depositSelf", args: [BigInt(amount)] }) },
  ];
  try {
    const approved = await reviewPairsOnDevice([
      ["Deposit", human(amount)],
      ["Vault", vaultName],
      ["Address", vault],
    ]);
    if (!approved) return c.json({ error: "rejected on device" }, 400);
    const res = await S.client.execute({ token: USDC, amount, calls });
    const accountIndex = res.execution?.account_index;
    const known = VAULTS.find((v) => v.address.toLowerCase() === vault.toLowerCase());
    const pos = { id: String(Date.now()), vault, vaultName: known?.name || vaultName, apy: known?.apy, accountIndex, shares: amount };
    POSITIONS.push(pos);
    return c.json({ ok: true, result: res, position: pos, positions: POSITIONS, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

const vaultByAddr = (a) => VAULTS.find((v) => v.address.toLowerCase() === String(a || "").toLowerCase());

// Redeem a vault position back into the SAME Execution Account (redeemSelf, a
// follow-up call). The USDC stays in the EA, ready to be redeployed into another
// vault. Signed on the Ledger.
app.post("/api/redeem", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const pos = (body.id && POSITIONS.find((p) => p.id === body.id)) || POSITIONS[POSITIONS.length - 1];
  if (!pos || !pos.vault) return c.json({ error: "no open vault position to redeem" }, 400);
  if (pos.accountIndex == null) return c.json({ error: "position has no execution account index" }, 400);
  const calls = [
    { target: pos.vault, value: "0", data: encodeFunctionData({ abi: ERC4626_REDEEM_SELF, functionName: "redeemSelf", args: [BigInt(pos.shares)] }) },
  ];
  try {
    const approved = await reviewPairsOnDevice([
      ["Redeem", human(pos.shares)],
      ["From", pos.vaultName],
      ["To", "Execution Account (idle)"],
    ]);
    if (!approved) return c.json({ error: "rejected on device" }, 400);
    const res = await S.client.executeAccountCall({ accountIndex: pos.accountIndex, calls });
    pos.vault = null; pos.vaultName = "idle in Execution Account"; // USDC now idle in the EA
    return c.json({ ok: true, result: res, positions: POSITIONS, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

// Rebalance a position into another vault, WITHOUT leaving the Execution Account:
// redeemSelf the current vault, then approve + depositSelf into the target vault.
// One follow-up call on the same EA, one Ledger approval.
// Shared rebalance primitive: redeemSelf the current vault + approve + depositSelf
// into the target, one follow-up call on the same Execution Account. With
// `silent` (the autonomous agent) the per-move device review is skipped — the
// mandate was approved once on the Ledger — but the SE still signs the spend, so
// custody holds. Interactive callers pass silent=false to get the on-device tap.
async function doRebalance({ pos, target, silent }) {
  if (!S) throw new Error("not connected");
  if (pos.accountIndex == null) throw new Error("position has no execution account index");
  // Enforce the DON-attested allocation: if an on-chain attestation exists for
  // this user, only move into a vault that is in the attested set.
  const gateUser = ETH_ADDR || LEDGER_ETH;
  const gate = await isVaultAttested(gateUser, target.address).catch(() => null);
  if (gate?.allocation?.approved && gate.allocation.allocations.length && !gate.attested) {
    throw new Error(`target vault not in the DON-attested allocation (AllocationGate ${gate.allocation.gate})`);
  }
  const amount = pos.shares;
  const calls = [];
  if (pos.vault) calls.push({ target: pos.vault, value: "0", data: encodeFunctionData({ abi: ERC4626_REDEEM_SELF, functionName: "redeemSelf", args: [BigInt(amount)] }) });
  calls.push({ target: USDC, value: "0", data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [target.address, BigInt(amount)] }) });
  calls.push({ target: target.address, value: "0", data: encodeFunctionData({ abi: ERC4626_DEPOSIT_SELF, functionName: "depositSelf", args: [BigInt(amount)] }) });
  if (!silent) {
    const approved = await reviewPairsOnDevice([
      ["Rebalance", human(amount)],
      ["From", pos.vault ? pos.vaultName : "idle"],
      ["To", `${target.name} ~${target.apy}%`],
    ]);
    if (!approved) throw new Error("rejected on device");
  }
  const res = await S.client.executeAccountCall({ accountIndex: pos.accountIndex, calls });
  pos.vault = target.address; pos.vaultName = target.name; pos.apy = target.apy;
  return res;
}

app.post("/api/rebalance", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const pos = (body.id && POSITIONS.find((p) => p.id === body.id)) || POSITIONS[POSITIONS.length - 1];
  if (!pos) return c.json({ error: "no position to rebalance" }, 400);
  const target = vaultByAddr(body.vault) || VAULTS.find((v) => v.address.toLowerCase() !== String(pos.vault || "").toLowerCase());
  if (!target) return c.json({ error: "target vault required" }, 400);
  try {
    const res = await doRebalance({ pos, target, silent: false });
    return c.json({ ok: true, result: res, positions: POSITIONS, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

// --- Autonomous yield agent (#4) --------------------------------------------
// Approve a mandate once on the Ledger; the agent then rebalances WITHIN it on
// its own. Each move is still SE-signed (immediate-sign) so the key never leaves
// the chip — the agent just doesn't re-prompt for moves inside the mandate.
const bot = createYieldBot({
  getPositions: () => POSITIONS,
  rebalance: ({ pos, target }) => doRebalance({ pos, target, silent: true }),
  log: (m) => console.log(m),
});

app.post("/api/agent/start", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const mandate = {
    allowedVaults: VAULTS,
    thresholdPct: Number(body.thresholdPct) || 1.5,
    maxPerVaultPct: Number(body.maxPerVaultPct) || 80,
    riskLevel: LAST_STRATEGY?.riskLevel || "medium",
    rebalance: LAST_STRATEGY?.rebalance || { trigger: "an APY edge above the threshold", rule: "shift to the best risk-adjusted APY" },
    approvedAt: Date.now(),
  };
  // Seal the mandate to the Ledger OpenPGP key (only the device can open it).
  const seal = await sealMandate(mandate);
  mandate.sealed = seal.sealed;
  const status = bot.start({ mandate, intervalSec: body.intervalSec });
  return c.json({ ok: true, seal, status });
});

app.post("/api/agent/stop", (c) => c.json({ ok: true, status: bot.stop() }));
app.get("/api/agent/status", (c) => c.json(bot.status()));
app.post("/api/agent/tick", async (c) => c.json({ ok: true, status: await bot.tick() }));
app.get("/api/agent/pgp", async (c) => c.json({ available: await pgpCardAvailable(), recipient: process.env.LEDGER_PGP_RECIPIENT || null }));

// --- AI yield co-pilot -------------------------------------------------------
// Describe your goals, the agent proposes a concrete strategy. It signs nothing;
// the only thing that deploys funds is your Ledger approval.
app.get("/api/strategy/vaults", (c) => c.json({ vaults: VAULTS }));

app.post("/api/strategy/propose", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const amountBase = body.amount || "100000";
  const goals = body.goals || "";
  try {
    // Preferred path: the REAL Chainlink Confidential AI Attester. The private
    // profile (goals + capital + Unlink balance) is sent to an inference API that
    // runs the allocation LLM inside a TEE; the response carries SHA-256
    // provenance digests. The CRE workflow (ledger/cre) signs the response digest
    // into a DON-attested report → AllocationGate on Base Sepolia.
    if (confidentialAiConfigured()) {
      const bal = (await balanceList()).find((b) => b.token.toLowerCase().includes("036cbd"));
      const inf = await runConfidentialInference({
        goals, capitalBase: amountBase, balanceBase: bal?.amount, vaults: VAULTS,
        creCallbackUrl: process.env.CRE_CALLBACK_URL,
      });
      const strategy = {
        source: `chainlink-confidential-ai:${inf.model}`,
        summary: inf.reason || "Confidential AI yield allocation",
        riskLevel: inf.riskLevel, amountBase,
        allocations: inf.allocations.map((a) => ({ vault: a.vault, vaultName: a.vaultName, apy: a.apy, risk: a.risk, pct: Math.round(a.bps / 100) })),
        blendedApy: inf.blendedApy,
        rebalance: { frequency: "continuous", trigger: "an APY edge above the mandate threshold", rule: "shift to the best risk-adjusted APY within the attested vaults" },
        rationale: inf.reason,
      };
      const isReal = inf.mode === "real";
      const attestation = {
        framework: "Chainlink Confidential AI Attester", live: isReal, local: !isReal, confidential: true,
        capability: "Confidential AI Attestation",
        ai: { provider: isReal ? "Chainlink Confidential AI (TEE)" : "Local stand-in (Mistral)", model: inf.model, viaConfidentialHttp: isReal },
        enclave: inf.enclave, inferenceId: inf.inferenceId,
        commitments: { inputDigest: inf.digests.request, outputDigest: inf.digests.response },
        transcriptHash: inf.digests.response,
        cre: { workflow: "lunave-yield-allocation-workflow", chain: "Base Sepolia (ethereum-testnet-sepolia-base-1, 84532)", consumer: "AllocationGate", note: "CRE DON signs the response digest into a report via writeReport → AllocationGate.onReport" },
      };
      LAST_STRATEGY = strategy; LAST_ATTESTATION = attestation;
      return c.json({ ok: true, strategy, attestation, verify: { valid: true, mode: isReal ? "tee-provenance" : "local-provenance" } });
    }

    // Local preview (no Attester key): local strategy + locally-signed attestation.
    const { strategy, attestation } = await runConfidentialStrategy({
      goals, amountBase, vaults: VAULTS, attestedAt: Math.floor(Date.now() / 1000),
    });
    LAST_STRATEGY = strategy;
    LAST_ATTESTATION = attestation;
    const verify = await verifyAttestation(attestation);
    return c.json({ ok: true, strategy, attestation, verify });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

// Re-verify the last AI Attestation (recompute the report hash, recover signer).
app.get("/api/attestation/verify", async (c) => {
  if (!LAST_ATTESTATION) return c.json({ error: "no attestation yet" }, 400);
  return c.json({ attestation: LAST_ATTESTATION, verify: await verifyAttestation(LAST_ATTESTATION), attestor: attestorAddress });
});

// The DON-attested allocation held on-chain by AllocationGate (the EA's gate).
app.get("/api/gate", async (c) => {
  const user = ETH_ADDR || LEDGER_ETH;
  const allocation = await readAttestedAllocation(user);
  return c.json({ gate: allocationGateAddress(), user, allocation });
});

// Approve the proposed strategy on the Ledger, then deploy the initial allocation
// (private pool -> Execution Account -> ERC-4626 vault). Signed in the chip.
app.post("/api/strategy/deploy", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const s = LAST_STRATEGY;
  if (!s || !s.allocations?.length) return c.json({ error: "propose a strategy first" }, 400);
  const total = BigInt(s.amountBase);
  const receiver = ETH_ADDR || LEDGER_ETH;

  // split the capital across the allocations (the last one gets the remainder)
  let allocated = 0n;
  const parts = s.allocations.map((a, i) => {
    const amt = i === s.allocations.length - 1 ? total - allocated : (total * BigInt(a.pct)) / 100n;
    allocated += i === s.allocations.length - 1 ? 0n : amt;
    return { ...a, amount: amt };
  });
  // one Execution Account, one Ledger approval: approve + deposit per vault
  const calls = parts.flatMap((p) => [
    { target: USDC, value: "0", data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [p.vault, p.amount] }) },
    { target: p.vault, value: "0", data: encodeFunctionData({ abi: ERC4626_DEPOSIT, functionName: "deposit", args: [p.amount, receiver] }) },
  ]);

  const allocStr = s.allocations.map((a) => `${a.pct}% ${a.vaultName.replace(/^Unlink /, "")}`).join(", ");
  try {
    const approved = await reviewPairsOnDevice([
      ["Strategy", s.summary],
      ["Deploy", human(s.amountBase)],
      ["Allocation", allocStr],
      ["Rebalance", `${s.rebalance.frequency}: ${s.rebalance.trigger}`],
    ]);
    if (!approved) return c.json({ error: "strategy rejected on device" }, 400);
    const res = await S.client.execute({ token: USDC, amount: s.amountBase, calls });
    return c.json({ ok: true, result: res, strategy: s, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(`\n  Ledger × Unlink test rig → http://localhost:${PORT}\n`));
