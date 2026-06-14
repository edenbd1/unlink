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
import { proposeStrategy } from "../host/yield-agent.mjs";

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
let LAST_STRATEGY = null; // last proposed strategy, deployed on approval

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
    const pos = { id: String(Date.now()), vault, vaultName, accountIndex, shares: amount };
    POSITIONS.push(pos);
    return c.json({ ok: true, result: res, position: pos, positions: POSITIONS, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

// Redeem an open vault position: redeemSelf from the SAME Execution Account (a
// follow-up call, no new private withdrawal), then deposit the USDC back into
// the private pool. Signed on the Ledger.
app.post("/api/redeem", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const pos = (body.id && POSITIONS.find((p) => p.id === body.id)) || POSITIONS[POSITIONS.length - 1];
  if (!pos) return c.json({ error: "no open position to redeem" }, 400);
  if (pos.accountIndex == null) return c.json({ error: "position has no execution account index" }, 400);
  const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  const MAX = (1n << 256n) - 1n;
  const calls = [
    // redeem the shares -> USDC into the Execution Account, then let Permit2 pull
    // it for the deposit-back into the private pool.
    { target: pos.vault, value: "0", data: encodeFunctionData({ abi: ERC4626_REDEEM_SELF, functionName: "redeemSelf", args: [BigInt(pos.shares)] }) },
    { target: USDC, value: "0", data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [PERMIT2, MAX] }) },
  ];
  const nonce = globalThis.crypto.getRandomValues(new BigUint64Array(1))[0].toString();
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  try {
    const approved = await reviewPairsOnDevice([
      ["Redeem", human(pos.shares)],
      ["From", pos.vaultName],
      ["To", "your private pool"],
    ]);
    if (!approved) return c.json({ error: "rejected on device" }, 400);
    const res = await S.client.executeAccountCall({
      accountIndex: pos.accountIndex,
      calls,
      depositBack: { token: USDC, amount: pos.shares, nonce, deadline },
    });
    POSITIONS = POSITIONS.filter((p) => p.id !== pos.id);
    return c.json({ ok: true, result: res, positions: POSITIONS, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

// --- AI yield co-pilot -------------------------------------------------------
// Describe your goals, the agent proposes a concrete strategy. It signs nothing;
// the only thing that deploys funds is your Ledger approval.
app.get("/api/strategy/vaults", (c) => c.json({ vaults: VAULTS }));

app.post("/api/strategy/propose", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const amountBase = body.amount || "100000";
  try {
    const strategy = await proposeStrategy({ goals: body.goals || "", amountBase, vaults: VAULTS });
    LAST_STRATEGY = strategy;
    return c.json({ ok: true, strategy });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
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
