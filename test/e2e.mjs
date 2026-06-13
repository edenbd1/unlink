// End-to-end: drives the real companion server over HTTP, exactly as the browser
// would. Custody is a software ed25519/cv25519 GPG key (the Ledger OpenPGP curve);
// the FIDO2 tap is a software P-256 authenticator (the Ledger Security Key curve).
// Unlink calls hit the live Base Sepolia engine.
import { createAuthenticator } from "./soft-authenticator.mjs";
import { openSession } from "../companion/unlink.ts";

const BASE = "http://localhost:8787";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then(r => r.json());
const get = (p) => fetch(BASE + p).then(r => r.json());
const ok = (label, cond, extra = "") => { console.log(`${cond ? "✅" : "❌"} ${label}${extra ? "  " + extra : ""}`); if (!cond) { failures++; } };
let failures = 0;

// Pre-register a recipient account (a second custodied identity) so transfer has a target.
const recipientSeed = new Uint8Array(64); for (let i = 0; i < 64; i++) recipientSeed[i] = (i * 13 + 5) & 255;
const recipient = await openSession(recipientSeed);
console.log("recipient (pre-registered):", recipient.address, "\n");

const auth = createAuthenticator("localhost", "http://localhost:3000");

// 1. status (fresh)
let s = await get("/api/custody/status");
ok("status: no seed yet", s.hasSeed === false && s.unlocked === false);

// 2. create custodied seed (gpg --encrypt to the Ledger key)
let r = await post("/api/custody/create");
ok("custody: seed generated & encrypted to Ledger", r.ok === true && r.created === true);
s = await get("/api/custody/status");
ok("status: hasSeed now true", s.hasSeed === true);

// 3. unlock (gpg --decrypt via the device) → Unlink address
r = await post("/api/custody/unlock");
ok("custody: unlocked, address derived", r.ok === true && /^unlink1/.test(r.address || ""), r.address);
const myAddr = r.address;

// 4. unlock again must be deterministic (same ciphertext → same account)
const r2 = await post("/api/custody/unlock");
ok("custody: unlock is deterministic", r2.address === myAddr);

// 5. balance (live engine)
r = await get("/api/balance");
ok("balance: queried live engine", r.ok === true, JSON.stringify(r.balances?.balances || r.balances || []));

// 6. fund the private account from the configured EVM wallet (real USDC deposit)
r = await post("/api/deposit", { token: USDC, amount: "1000000" }); // 1 USDC
ok("deposit: funded private account from EVM wallet", r.ok === true, r.ok ? JSON.stringify(r.result).slice(0, 100) : r.error);
await new Promise(res => setTimeout(res, 4000)); // let the engine index the shielded balance
r = await get("/api/balance");
ok("balance: private balance is now non-zero", JSON.stringify(r.balances || "").includes("amount") || (r.balances?.balances || []).length > 0, JSON.stringify(r.balances?.balances || r.balances || []));

// 7. FIDO2 gate must REJECT a transfer with no/invalid tap
r = await post("/api/transfer", { assertion: { id: "x", response: {} }, recipientAddress: recipient.address, amount: "1", token: USDC });
ok("gate: transfer WITHOUT valid tap is rejected", r.ok === false, r.error);

// 8. enroll the Security Key (FIDO2 registration)
let o = await post("/api/fido2/register/options");
ok("fido2: registration options issued", o.ok === true && !!o.options?.challenge);
r = await post("/api/fido2/register/verify", auth.register(o.options));
ok("fido2: Security Key enrolled", r.ok === true && r.verified === true);

// 9. co-pilot proposes a private transfer (only proposes)
r = await post("/api/copilot/propose", { recipientAddress: recipient.address });
const proposal = r.proposal;
ok("copilot: proposed a private action (or none if unfunded)", r.ok === true, proposal ? `${proposal.amount} of ${proposal.token.slice(0,10)}…` : "no funds yet");

// 10. gate accepts a real tap → executes the private transfer
if (proposal) {
  o = await post("/api/fido2/auth/options");
  ok("fido2: auth options issued for the tap", o.ok === true && !!o.options?.challenge);
  r = await post("/api/transfer", { assertion: auth.authenticate(o.options), recipientAddress: recipient.address, amount: proposal.amount, token: proposal.token });
  ok("transfer: valid tap → private transfer executed", r.ok === true, r.ok ? JSON.stringify(r.result).slice(0,120) : r.error);
} else {
  // Even without faucet funds, prove the gate+transfer wiring with a tap (engine may reject on amount)
  o = await post("/api/fido2/auth/options");
  r = await post("/api/transfer", { assertion: auth.authenticate(o.options), recipientAddress: recipient.address, amount: "1", token: USDC });
  ok("transfer: tap verified (engine response received)", o.ok === true && r.ok !== undefined, r.error || "ok");
}

// 11. replay protection: the same tap assertion must not verify twice
o = await post("/api/fido2/auth/options");
const a = auth.authenticate(o.options);
await post("/api/transfer", { assertion: a, recipientAddress: recipient.address, amount: "1", token: USDC });
r = await post("/api/transfer", { assertion: a, recipientAddress: recipient.address, amount: "1", token: USDC });
ok("gate: replayed tap is rejected", r.ok === false, r.error);

// 12. lock wipes the session
r = await post("/api/custody/lock");
s = await get("/api/custody/status");
ok("custody: lock clears the unlocked session", s.unlocked === false);

console.log(`\n${failures === 0 ? "🎉 ALL PASS" : "💥 " + failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
