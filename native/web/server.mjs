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
import { buildDeviceAccount, reviewIntentOnDevice, connectApproveOnDevice } from "../host/device-account.mjs";
import { ledgerEthClients, getLedgerEthAddress } from "../host/ledger-eth-account.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = process.env.UNLINK_ENVIRONMENT || "base-sepolia";
const API_KEY = process.env.UNLINK_API_KEY || "";
const FUNDING_PK = process.env.FUNDING_PRIVATE_KEY || "";
const USDC = process.env.DEMO_TOKEN || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DEMO_VAULT = process.env.DEMO_VAULT || "0xaf1ac7cd3f19e008129d1b7cd8da5daa09143482"; // ERC-4626 demo vault (USDC)
const LEDGER_ETH = process.env.LEDGER_ETH_ADDRESS || "0x065dF3372c1f9f86f5cfC220db027da2A754fdbF";
const PORT = Number(process.env.WEB_PORT || 8799);

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
    const approved = await reviewIntentOnDevice(human(amount), shortAddr(to));
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

app.post("/api/execute", async (c) => {
  if (!S) return c.json({ error: "not connected" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const amount = body.amount || "100000";
  const vault = body.vault || DEMO_VAULT;
  const receiver = body.receiver || ETH_ADDR || LEDGER_ETH;
  if (!vault) return c.json({ error: "vault address required" }, 400);
  const calls = [
    { target: USDC, value: "0", data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [vault, BigInt(amount)] }) },
    { target: vault, value: "0", data: encodeFunctionData({ abi: ERC4626_DEPOSIT, functionName: "deposit", args: [BigInt(amount), receiver] }) },
  ];
  try {
    const approved = await reviewIntentOnDevice(human(amount), "vault via EA");
    if (!approved) return c.json({ error: "rejected on device" }, 400);
    const res = await S.client.execute({ token: USDC, amount, calls });
    return c.json({ ok: true, result: res, balances: await balanceList() });
  } catch (e) { return c.json({ error: String(e.message || e) }, 500); }
});

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(`\n  Ledger × Unlink test rig → http://localhost:${PORT}\n`));
