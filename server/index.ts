import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createCustodiedSeed, decryptSeed, hasCustodiedSeed } from "../companion/gpg-custody.ts";
import { openSession, getBalances, privateTransfer, faucet, depositFromWallet, type Session } from "../companion/unlink.ts";
import * as fido2 from "./fido2.ts";
import { propose } from "./copilot.ts";

const PORT = Number(process.env.PORT || 8787);
const RECIPIENT = process.env.LEDGER_OPENPGP_RECIPIENT || "";
const app = new Hono();
app.use("*", cors());

// In-memory unlocked session (the decrypted seed never touches disk).
let session: Session | null = null;
const requireSession = () => { if (!session) throw new Error("locked — unlock first"); return session; };
const json = (c: any, fn: () => Promise<any>) => fn().then(d => c.json({ ok: true, ...d })).catch((e: any) => c.json({ ok: false, error: String(e?.message || e) }, 400));

// --- Custody (Ledger OpenPGP) ---
app.get("/api/custody/status", c => c.json({ hasSeed: hasCustodiedSeed(), unlocked: !!session, enrolled: fido2.isEnrolled() }));
app.post("/api/custody/create", c => json(c, async () => {
  if (!RECIPIENT) throw new Error("set LEDGER_OPENPGP_RECIPIENT in .env");
  await createCustodiedSeed(RECIPIENT);
  return { created: true };
}));
app.post("/api/custody/unlock", c => json(c, async () => {
  const seed = await decryptSeed();           // prompts on the Ledger
  session = await openSession(seed);
  seed.fill(0);                               // wipe plaintext seed
  return { address: session.address };
}));
app.post("/api/custody/lock", c => { session = null; return c.json({ ok: true, locked: true }); });

// --- Balances / faucet ---
app.get("/api/balance", c => json(c, async () => ({ balances: await getBalances(requireSession()) })));
app.post("/api/faucet", c => json(c, async () => {
  const { token, amount } = await c.req.json();
  return { result: await faucet(requireSession(), token, amount) };
}));
// Fund the private account from a configured EVM wallet (approve + deposit).
app.post("/api/deposit", c => json(c, async () => {
  const { token, amount } = await c.req.json();
  return { result: await depositFromWallet(requireSession(), token, amount) };
}));

// --- Co-pilot proposal (proposes only) ---
app.post("/api/copilot/propose", c => json(c, async () => {
  const s = requireSession();
  const { recipientAddress } = await c.req.json();
  const bal = await getBalances(s);
  const balances = (bal?.balances || bal || []) as any[];
  return { proposal: await propose(balances, recipientAddress || s.address) };
}));

// --- FIDO2 (Ledger Security Key) ---
app.post("/api/fido2/register/options", c => json(c, async () => ({ options: await fido2.regOptions() })));
app.post("/api/fido2/register/verify", c => json(c, async () => fido2.regVerify(await c.req.json())));
app.post("/api/fido2/auth/options", c => json(c, async () => ({ options: await fido2.authOptions() })));

// --- Gated private transfer: requires a verified Ledger tap in the same request ---
app.post("/api/transfer", c => json(c, async () => {
  const s = requireSession();
  const { assertion, recipientAddress, amount, token } = await c.req.json();
  await fido2.authVerify(assertion);          // physical tap or it throws
  const result = await privateTransfer(s, recipientAddress, amount, token);
  return { result };
}));

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(`Unlink companion on http://localhost:${PORT} (env: ${process.env.UNLINK_ENVIRONMENT || "base-sepolia"})`));
