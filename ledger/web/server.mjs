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
import { readAttestedAllocation, isVaultAttested, allocationGateAddress, writeAttestedAllocation } from "../host/allocation-gate.mjs";
import { createYieldBot } from "../host/yield-bot.mjs";
import { sealMandate, unsealMandate, pgpCardAvailable } from "../host/mandate-seal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = process.env.UNLINK_ENVIRONMENT || "base-sepolia";
const API_KEY = process.env.UNLINK_API_KEY || "";
const FUNDING_PK = process.env.FUNDING_PRIVATE_KEY || "";
const USDC = process.env.DEMO_TOKEN || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DEMO_VAULT = process.env.DEMO_VAULT || "0xedf18f946344395d9fc5e20a67289ccce3f25b6f"; // ERC-4626 demo vault (USDC), depositSelf/redeemSelf
const LEDGER_ETH = process.env.LEDGER_ETH_ADDRESS || "0x065dF3372c1f9f86f5cfC220db027da2A754fdbF";
const PORT = Number(process.env.WEB_PORT || 8799);

// ERC-4626 USDC vaults the yield agent can allocate to. The Stable bucket maps to
// an Aave-style market (lower, safer APY), the Growth bucket to a Morpho-style
// vault (higher APY). NOTE: these are our ERC-4626 vaults on Base Sepolia, branded
// after the protocols they model — real Aave/Morpho testnets use their own faucet
// tokens, not the Circle USDC we shield through Unlink, so we keep working vaults
// and present them as the protocols. Swap the addresses for real adapters on a
// network where those protocols share our USDC.
const VAULTS = [
  { address: "0xedf18f946344395d9fc5e20a67289ccce3f25b6f", name: "Aave USDC", protocol: "Aave v3", apy: 4.1, risk: "low" },
  { address: "0x8d84354e9ca75e48a665b00f7127314a7610d254", name: "Spark USDC", protocol: "Spark", apy: 4.8, risk: "low" },
  { address: "0x575a35d30428d5ce32c729103a7bef20eb3e016c", name: "Moonwell USDC", protocol: "Moonwell", apy: 5.5, risk: "medium" },
  { address: "0xb36a7f5b19fca57ae751d68fb012e1c29f3fe425", name: "Fluid USDC", protocol: "Fluid", apy: 6.3, risk: "medium" },
  { address: "0x72f8b23d52a5fed3e383b752c6f20b43b625200e", name: "Euler USDC", protocol: "Euler", apy: 6.9, risk: "high" },
  { address: "0xe7c683e76b3a99d32cbda67beb33eedacaf6f90f", name: "Morpho USDC", protocol: "Morpho", apy: 7.4, risk: "high" },
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

const ERC20_BALANCE_OF = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];
const readClient = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC || "https://base-sepolia-rpc.publicnode.com") });

// Re-discover open vault positions + idle EA balances on-chain so funds from a
// previous session reappear after a restart/reconnect. The SDK lists the user's
// Execution Accounts (identity only — no balances); we read each deployed EA's
// vault and USDC balances directly on Base Sepolia.
async function discoverPositions(client) {
  try {
    const page = await client.executionAccounts.list({ limit: 100 });
    // status is "active" | "reserved" | null at runtime; deployed EAs are the ones
    // that have an on-chain address.
    const deployed = (page?.accounts || []).filter((a) => a.account_address);
    const found = [];
    for (const ea of deployed) {
      const addr = ea.account_address;
      for (const v of VAULTS) {
        const bal = await readClient.readContract({ address: v.address, abi: ERC20_BALANCE_OF, functionName: "balanceOf", args: [addr] }).catch(() => 0n);
        if (bal > 0n) found.push({ id: `ea${ea.account_index}-${v.address.slice(2, 8)}`, vault: v.address, vaultName: v.name, apy: v.apy, accountIndex: ea.account_index, shares: bal.toString() });
      }
      const idle = await readClient.readContract({ address: USDC, abi: ERC20_BALANCE_OF, functionName: "balanceOf", args: [addr] }).catch(() => 0n);
      if (idle > 0n) found.push({ id: `ea${ea.account_index}-idle`, vault: null, vaultName: "idle in Execution Account", accountIndex: ea.account_index, shares: idle.toString() });
    }
    return found;
  } catch (e) { console.log("[discover] positions:", String(e.message || e)); return []; }
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
    POSITIONS = await discoverPositions(client); // recover positions from prior sessions
    return c.json({ address: S.address, fromCache: !!account.fromCache, balances: await balanceList(), positions: POSITIONS });
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

// Rebalance the EA's positions to new target shares per vault, in ONE
// executeAccountCall: redeem the over-weight vaults, then approve + depositSelf
// the under-weight ones (the redeemed USDC funds the deposits). This MAINTAINS the
// approved allocation rather than consolidating. The agent calls it silent (no
// per-move tap) — the SE still signs every spend, so custody holds.
async function doPortfolioRebalance({ accountIndex, targetShares, silent }) {
  if (!S) throw new Error("not connected");
  if (accountIndex == null) throw new Error("no execution account index");
  const ps = POSITIONS.filter((p) => p.accountIndex === accountIndex && p.vault);
  const redeems = [], approves = [], deposits = [];
  for (const ts of targetShares) {
    const pos = ps.find((p) => p.vault.toLowerCase() === ts.vault.toLowerCase());
    const cur = pos ? BigInt(pos.shares) : 0n;
    const tgt = BigInt(ts.shares);
    if (tgt < cur) redeems.push({ target: ts.vault, value: "0", data: encodeFunctionData({ abi: ERC4626_REDEEM_SELF, functionName: "redeemSelf", args: [cur - tgt] }) });
    else if (tgt > cur) {
      approves.push({ target: USDC, value: "0", data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [ts.vault, tgt - cur] }) });
      deposits.push({ target: ts.vault, value: "0", data: encodeFunctionData({ abi: ERC4626_DEPOSIT_SELF, functionName: "depositSelf", args: [tgt - cur] }) });
    }
  }
  const calls = [...redeems, ...approves, ...deposits];
  if (!calls.length) return null;
  const res = await S.client.executeAccountCall({ accountIndex, calls });
  for (const ts of targetShares) {
    const known = VAULTS.find((v) => v.address.toLowerCase() === ts.vault.toLowerCase());
    let pos = ps.find((p) => p.vault.toLowerCase() === ts.vault.toLowerCase());
    if (!pos) { pos = { id: String(Date.now()) + Math.round(Math.random() * 1000), vault: ts.vault, vaultName: known?.name || ts.vaultName, apy: known?.apy, accountIndex, shares: ts.shares }; POSITIONS.push(pos); }
    else { pos.shares = ts.shares; pos.vaultName = known?.name || ts.vaultName; pos.apy = known?.apy ?? pos.apy; }
  }
  return res;
}

// --- Autonomous yield agent (#4) --------------------------------------------
// Approve a mandate (the target allocation) once on the Ledger; the agent then
// MAINTAINS those weights on its own, tilting only within an approved band toward
// the best risk-adjusted APY, never past the per-vault cap. Each move is still
// SE-signed (immediate-sign) so the key never leaves the chip.
const bot = createYieldBot({
  getPositions: () => POSITIONS,
  rebalancePortfolio: ({ accountIndex, targetShares }) => doPortfolioRebalance({ accountIndex, targetShares, silent: true }),
  log: (m) => console.log(m),
});

app.post("/api/agent/start", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const body = await c.req.json().catch(() => ({}));
  // The mandate's target allocation = the deployed strategy's weights. The agent
  // maintains them (tilt within the band, capped), never consolidating.
  let targets = (LAST_STRATEGY?.allocations || []).map((a) => {
    const v = VAULTS.find((vv) => vv.address.toLowerCase() === a.vault.toLowerCase());
    return v ? { vault: v.address, vaultName: v.name, apy: v.apy, risk: v.risk, targetBps: Math.round(a.pct * 100) } : null;
  }).filter(Boolean);
  if (!targets.length) targets = VAULTS.slice(0, 2).map((v, i) => ({ vault: v.address, vaultName: v.name, apy: v.apy, risk: v.risk, targetBps: i === 0 ? 6000 : 4000 }));
  const sumB = targets.reduce((s, t) => s + t.targetBps, 0);
  if (sumB !== 10000) targets[0].targetBps += 10000 - sumB; // normalize to 100%
  const mandate = {
    targets,
    accountIndex: LAST_STRATEGY?.accountIndex ?? null, // the EA holding this strategy
    thresholdPct: Number(body.thresholdPct) || 1.5,
    bandBps: Math.round((Number(body.bandPct) || 15) * 100),       // tilt band ±15% by default
    maxPerVaultBps: Math.round((Number(body.maxPerVaultPct) || 80) * 100),
    rebalanceTolBps: Math.round((Number(body.tolPct) || 3) * 100), // act on >3% drift
    riskLevel: LAST_STRATEGY?.riskLevel || "medium",
    rebalance: LAST_STRATEGY?.rebalance || { frequency: "continuous", trigger: "drift from the target weights", rule: "tilt within the band toward the best risk-adjusted APY" },
    approvedAt: Date.now(),
  };
  // Seal the mandate to the Ledger OpenPGP key, then REQUIRE the physical Ledger
  // to open it (decrypt + PIN) to arm — the OpenPGP unseal is a hard gate, so the
  // agent literally cannot start unless the device opens the mandate. The rules
  // the agent obeys are under hardware custody.
  const seal = await sealMandate(mandate);
  mandate.sealed = seal.sealed;
  if (seal.sealed) {
    try {
      const opened = await unsealMandate(); // gpg --decrypt -> scdaemon -> Ledger OpenPGP app (PIN)
      if (!opened || JSON.stringify(opened.targets) !== JSON.stringify(mandate.targets)) throw new Error("mandate integrity mismatch");
      mandate.unsealed = true;
    } catch (e) {
      return c.json({ error: `Mandate locked. Open the Ledger OpenPGP app and approve (PIN) to arm the agent. (${String(e.message || e).split("\n")[0]})`, needsUnseal: true }, 400);
    }
  }
  const status = bot.start({ mandate, intervalSec: body.intervalSec });
  return c.json({ ok: true, seal, unsealed: !!mandate.unsealed, status });
});

app.post("/api/agent/stop", (c) => c.json({ ok: true, status: bot.stop() }));
app.get("/api/agent/status", (c) => c.json(bot.status()));
app.post("/api/agent/tick", async (c) => c.json({ ok: true, status: await bot.tick() }));
app.get("/api/agent/pgp", async (c) => c.json({ available: await pgpCardAvailable(), recipient: process.env.LEDGER_PGP_RECIPIENT || null }));

// Redeem ALL open vault positions back to idle USDC in their Execution Account
// (exit the strategy). Stops the agent first so it doesn't redeploy. One device
// review, then one executeAccountCall per EA (redeemSelf every held vault).
app.post("/api/redeem-all", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  bot.stop();
  const open = POSITIONS.filter((p) => p.vault && p.accountIndex != null);
  if (!open.length) return c.json({ error: "no open vault positions to redeem" }, 400);
  const byEA = new Map();
  for (const p of open) { if (!byEA.has(p.accountIndex)) byEA.set(p.accountIndex, []); byEA.get(p.accountIndex).push(p); }
  let totalBase = 0n; open.forEach((p) => (totalBase += BigInt(p.shares)));
  try {
    const approved = await reviewPairsOnDevice([
      ["Redeem all", human(totalBase.toString())],
      ["From", `${open.length} vault${open.length > 1 ? "s" : ""}`],
      ["To", "Execution Account (idle)"],
    ]);
    if (!approved) return c.json({ error: "rejected on device" }, 400);
    for (const [accountIndex, ps] of byEA) {
      const calls = ps.map((p) => ({ target: p.vault, value: "0", data: encodeFunctionData({ abi: ERC4626_REDEEM_SELF, functionName: "redeemSelf", args: [BigInt(p.shares)] }) }));
      await S.client.executeAccountCall({ accountIndex, calls });
      ps.forEach((p) => { p.vault = null; p.vaultName = "idle in Execution Account"; });
    }
    return c.json({ ok: true, redeemed: human(totalBase.toString()), count: open.length, positions: POSITIONS, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

// --- AI yield co-pilot -------------------------------------------------------
// Describe your goals, the agent proposes a concrete strategy. It signs nothing;
// the only thing that deploys funds is your Ledger approval.
app.get("/api/strategy/vaults", (c) => c.json({ vaults: VAULTS }));

// Build a proposal (strategy + attestation) for goals + amount. Sets LAST_*.
async function buildProposal({ goals, amountBase }) {
  // Preferred path: the REAL Chainlink Confidential AI Attester (or the local
  // stand-in). The private profile (goals + capital + balance) runs through the
  // inference API; the response carries SHA-256 provenance digests that the CRE
  // workflow signs into a DON-attested report → AllocationGate on Base Sepolia.
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
    return { strategy, attestation, verify: { valid: true, mode: isReal ? "tee-provenance" : "local-provenance" } };
  }
  // Local preview (no Attester at all): local strategy + locally-signed attestation.
  const { strategy, attestation } = await runConfidentialStrategy({
    goals, amountBase, vaults: VAULTS, attestedAt: Math.floor(Date.now() / 1000),
  });
  LAST_STRATEGY = strategy; LAST_ATTESTATION = attestation;
  return { strategy, attestation, verify: await verifyAttestation(attestation) };
}

app.post("/api/strategy/propose", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json({ ok: true, ...(await buildProposal({ goals: body.goals || "", amountBase: body.amount || "100000" })) });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

// Parse a USDC amount out of free text: "$10,000", "10,000 USDC", "10k", "0.5".
function parseAmount(text) {
  const m = String(text).match(/(?:\$\s*)?(\d[\d,]*\.?\d*)\s*(k|usdc|usd|\$)?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(n) || n <= 0) return null;
  if (/^k$/i.test(m[2] || "")) n *= 1000;
  return String(Math.round(n * 1e6)); // base units (6 decimals)
}

// Conversational co-pilot: you just talk to it. It parses the amount + reads your
// goals from the message, fills defaults when you're vague, proposes a concrete
// strategy and asks you to confirm. Confirming hits /api/strategy/deploy (Ledger).
app.post("/api/strategy/chat", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const { message = "" } = await c.req.json().catch(() => ({}));
  if (!message.trim()) return c.json({ error: "say what you'd like to do" }, 400);
  const parsed = parseAmount(message);
  const bal = (await balanceList()).find((b) => b.token.toLowerCase().includes("036cbd"));
  const amountBase = parsed || (bal && Number(bal.amount) > 0 ? bal.amount : "100000");
  try {
    const { strategy, attestation, verify } = await buildProposal({ goals: message, amountBase });
    const allocStr = strategy.allocations.map((a) => `${a.pct}% ${a.vaultName.replace(/^Unlink /, "")}`).join(" + ");
    const lead = parsed
      ? `Got it — ${human(amountBase)} it is. `
      : `You didn't give an amount, so I'll assume ${human(amountBase)} (your private balance). `;
    const reply =
      `${lead}Here's my plan: ${allocStr}, ~${strategy.blendedApy}% blended APY (${strategy.riskLevel} risk). ` +
      `${strategy.rationale ? strategy.rationale + " " : ""}` +
      `It rebalances ${strategy.rebalance.frequency} when there's ${strategy.rebalance.trigger}. ` +
      `Sound good? Confirm to deploy — you'll approve it on your Ledger.`;
    return c.json({ ok: true, reply, assumedAmount: !parsed, amountBase, strategy, attestation, verify });
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

  // Cap the deploy to the private balance (so a big quoted amount still works).
  const bal = (await balanceList()).find((b) => b.token.toLowerCase().includes("036cbd"));
  const balBase = BigInt(bal?.amount || "0");
  if (balBase === 0n) return c.json({ error: "no private balance to deploy — shield some USDC first" }, 400);
  const total = BigInt(s.amountBase) <= balBase ? BigInt(s.amountBase) : balBase;

  // split the capital across the allocations (the last one gets the remainder)
  let allocated = 0n;
  const parts = s.allocations.map((a, i) => {
    const amt = i === s.allocations.length - 1 ? total - allocated : (total * BigInt(a.pct)) / 100n;
    allocated += i === s.allocations.length - 1 ? 0n : amt;
    return { ...a, amount: amt };
  }).filter((p) => p.amount > 0n);
  // one Execution Account, one Ledger approval: approve + depositSelf per vault,
  // so the EA holds the shares and the autonomous agent can redeem/rebalance them.
  const calls = parts.flatMap((p) => [
    { target: USDC, value: "0", data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [p.vault, p.amount] }) },
    { target: p.vault, value: "0", data: encodeFunctionData({ abi: ERC4626_DEPOSIT_SELF, functionName: "depositSelf", args: [p.amount] }) },
  ]);

  const allocStr = s.allocations.map((a) => `${a.pct}% ${a.vaultName.replace(/^Unlink /, "")}`).join(", ");
  try {
    const approved = await reviewPairsOnDevice([
      ["Strategy", `${s.riskLevel} risk · ~${s.blendedApy}% APY`],
      ["Deploy", human(total.toString())],
      ["Allocation", allocStr],
      ["Rebalance", "autonomous, within mandate"],
    ]);
    if (!approved) return c.json({ error: "strategy rejected on device" }, 400);
    const res = await S.client.execute({ token: USDC, amount: total.toString(), calls });
    // Record one position per allocation on the new EA so the agent can manage them.
    const accountIndex = res.execution?.account_index;
    s.accountIndex = accountIndex; // the agent manages THIS strategy's EA (not older ones)
    const created = parts.map((p) => {
      const known = VAULTS.find((v) => v.address.toLowerCase() === p.vault.toLowerCase());
      const pos = { id: String(Date.now()) + Math.round(Number(p.amount) % 1000), vault: p.vault, vaultName: known?.name || p.vaultName, apy: known?.apy ?? p.apy, accountIndex, shares: p.amount.toString() };
      POSITIONS.push(pos); return pos;
    });
    // Reflect the deployed allocation on-chain (AllocationGate) so the agent is
    // gated to exactly this vault set. Best-effort; doesn't block the deploy.
    const gateTx = await writeAttestedAllocation({
      user: ETH_ADDR || LEDGER_ETH,
      allocations: parts.map((p) => ({ vault: p.vault, bps: p.pct * 100 })),
      blendedApyBps: Math.round((s.blendedApy || 0) * 100),
      transcriptHash: LAST_ATTESTATION?.transcriptHash, inferenceId: LAST_ATTESTATION?.inferenceId,
    });
    return c.json({ ok: true, result: res, strategy: s, deployed: human(total.toString()), positions: created, gateTx, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(`\n  Ledger × Unlink test rig → http://localhost:${PORT}\n`));
