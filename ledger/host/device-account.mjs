// Reconstruct a full Unlink account from what the Ledger exports — the spending
// PUBLIC key (A) and the viewing PRIVATE key — without ever holding the spending
// private key (it stays in the Secure Element). Mirrors the SDK's buildAccountKeys
// derivation exactly:
//   viewingPublicKey = ed25519.getPublicKey(viewingPrivateKey)
//   nullifyingKey    = poseidon1([mod(viewingPrivateKey)])
//   masterPublicKey  = poseidon3([Ax, Ay, nullifyingKey])
//   address          = bech32m("unlink", [0] ++ BE32(masterPublicKey) ++ viewingPubKey)
// Signing is delegated to the device (deviceSignSigningRequest = SignSigningRequestFn).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bech32m } from "@scure/base";
import { poseidon1, poseidon3 } from "poseidon-lite";
import { account as sdkAccount } from "@unlink-xyz/sdk/crypto";
import { getDeviceSpendingPublicKey, deviceSignSigningRequest } from "./device-signer.mjs";

// The SDK gates ExecutionAccount derivation behind a unique symbol method. Pull
// the exact symbol from a throwaway seed account so we can implement it on the
// device account: the device authorizes the pool withdrawal, while this seed
// (the viewing key) derives the EPHEMERAL Execution Account owner that runs the
// atomic DeFi call. Lets client.execute (Pool -> vault via EA) work device-side.
let _seedSym = null;
function seedBackedSymbol() {
  if (_seedSym) return _seedSym;
  const a = sdkAccount.fromSeed({ seed: new Uint8Array(32).fill(1) });
  for (let o = a; o && !_seedSym; o = Object.getPrototypeOf(o)) {
    _seedSym = Object.getOwnPropertySymbols(o).find((s) => s.description === "unlink.seedBackedAccountProvider") || null;
  }
  return _seedSym;
}

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const HRP = "unlink";
const VERSION = 0;

// Cache for the CONSTANT device-exported material (spending PUBLIC key + viewing
// key). Read once from the device, then reused so the Ledger app only needs to be
// open for the actual approve+sign of a transfer — never just to rebuild the
// account. The viewing key is a read capability (it never grants spend authority,
// which stays in the Secure Element). Gitignored; delete the file to force a
// re-read, or set DEVICE_NO_CACHE=1.
const CACHE = join(dirname(fileURLToPath(import.meta.url)), ".device-keys.json");

const mod = (x) => ((x % FIELD) + FIELD) % FIELD;
const bytesToBigInt = (b) => BigInt("0x" + Buffer.from(b).toString("hex"));
const toBytesBE = (x, len = 32) =>
  Uint8Array.from(Buffer.from(x.toString(16).padStart(len * 2, "0"), "hex"));

// Build the registration material from public + viewing material only.
export function buildRegistration(spendingPublicKey, viewingPrivateKey) {
  const viewingPubKey = ed25519.getPublicKey(viewingPrivateKey);
  const nullifyingKey = poseidon1([mod(bytesToBigInt(viewingPrivateKey))]);
  const masterPublicKey = poseidon3([spendingPublicKey[0], spendingPublicKey[1], nullifyingKey]);
  const payload = new Uint8Array(65);
  payload[0] = VERSION;
  payload.set(toBytesBE(masterPublicKey), 1);
  payload.set(viewingPubKey, 33);
  const address = bech32m.encode(HRP, bech32m.toWords(payload), 1023);
  return { address, spendingPublicKey, viewingPrivateKey, nullifyingKey };
}

// Read the constant key material — from the host cache if present, otherwise
// from the device (then cached). Pass {fresh:true} or DEVICE_NO_CACHE=1 to skip.
async function loadKeyMaterial(opts = {}) {
  const useCache = !opts.fresh && process.env.DEVICE_NO_CACHE !== "1";
  if (useCache && existsSync(CACHE)) {
    const c = JSON.parse(readFileSync(CACHE, "utf8"));
    return {
      spendingPublicKey: [BigInt(c.spendingPublicKey[0]), BigInt(c.spendingPublicKey[1])],
      viewingPrivateKey: Uint8Array.from(Buffer.from(c.viewingPrivateKey, "hex")),
      fromCache: true,
    };
  }
  const spendingPublicKey = await getDeviceSpendingPublicKey();   // opens the app once
  const viewingPrivateKey = await getDeviceViewingPrivateKey();
  writeFileSync(CACHE, JSON.stringify({
    spendingPublicKey: [spendingPublicKey[0].toString(), spendingPublicKey[1].toString()],
    viewingPrivateKey: Buffer.from(viewingPrivateKey).toString("hex"),
  }, null, 2));
  return { spendingPublicKey, viewingPrivateKey, fromCache: false };
}

// Full device account: registration material + the device-backed spend signer.
// Key material is cached host-side, so after the first run the Ledger app is only
// needed to approve+sign a transfer (not to rebuild the account).
export async function buildDeviceAccount(opts = {}) {
  const { spendingPublicKey, viewingPrivateKey, fromCache } = await loadKeyMaterial(opts);
  const reg = buildRegistration(spendingPublicKey, viewingPrivateKey);
  reg.fromCache = fromCache;
  const acct = {
    ...reg,
    // UnlinkSpendSigner + registration provider, duck-typed for the SDK.
    getAddress: async () => reg.address,
    getPublicKey: async () => spendingPublicKey,
    getRegistrationPayload: async () => reg,
    signSigningRequest: deviceSignSigningRequest,
  };
  // Seed-backed hook for ExecutionAccount (vault via EA): the device still
  // authorizes the pool withdrawal; this only derives the ephemeral EA owner.
  const sym = seedBackedSymbol();
  if (sym) acct[sym] = () => ({ seed: Uint8Array.from(viewingPrivateKey), accountIndex: 0 });
  return acct;
}

async function sendApduSW(apduHex, timeoutSec = 120) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const execFileP = promisify(execFile);
  const HERE = dirname(fileURLToPath(import.meta.url));
  const { stdout } = await execFileP("python3", [join(HERE, "..", "tools", "apdu.py"), apduHex, String(timeoutSec)]);
  const m = stdout.match(/RESP\s+([0-9a-fA-F]+)/);
  if (!m) throw new Error(`device: no response (${stdout.trim()})`);
  return m[1].slice(-4);
}

// Pairing approval shown on the device when a host connects ("Connect this
// account to the Unlink app?"). Resolves true on approval, false on rejection.
export async function connectApproveOnDevice() {
  return (await sendApduSW("e00a0000", 120)) === "9000";
}

// Show a transaction on the device (a list of [label, value] pairs) and wait for
// a physical approval, BEFORE the tx is prepared (so the tap is outside the
// engine's prepare->submit window). Resolves true on approval, false on reject.
export async function reviewPairsOnDevice(pairs) {
  // Send the FULL values (so a long unlink recipient address shows in full on the
  // device). Only truncate values if the whole payload won't fit the single-byte
  // APDU length (Lc <= 255) — e.g. a 4-field strategy review with long text.
  const trunc = (s, n) => { s = String(s); return n && s.length > n ? s.slice(0, n - 1) + "." : s; };
  const build = (maxVal) => {
    const parts = [];
    for (const [label, value] of pairs.slice(0, 4)) {
      parts.push(Buffer.from(trunc(label, 16), "utf8"), Buffer.from([0]),
                 Buffer.from(trunc(value, maxVal), "utf8"), Buffer.from([0]));
    }
    const j = Buffer.concat(parts);
    return j.subarray(0, j.length - 1); // drop the trailing NUL
  };
  let payload = build(0); // 0 = no value truncation: full addresses
  if (payload.length > 255) {
    for (const cap of [140, 100, 70, 48, 32]) { payload = build(cap); if (payload.length <= 255) break; }
    if (payload.length > 255) payload = payload.subarray(0, 255);
  }
  const apduHex = "e0090000" + payload.length.toString(16).padStart(2, "0") + payload.toString("hex");
  const sw = await sendApduSW(apduHex, 120);
  if (sw === "9000") return true;
  if (sw === "6985") return false; // user rejected on the device
  // Surface common app-state errors with an actionable hint.
  const hint = { "6d02": "open the Unlink app on your Ledger", "6d00": "open the Unlink app on your Ledger", "6e00": "wrong app — open the Unlink app", "5515": "unlock your Ledger" }[sw];
  throw new Error(hint ? `${hint} (device ${sw})` : `device returned ${sw}`);
}

// Convenience for a plain transfer (Amount + recipient address).
export async function reviewIntentOnDevice(amount, recipient) {
  return reviewPairsOnDevice([["Amount", amount], ["To", recipient]]);
}

// Read the viewing private key (32 bytes) from the device (INS 0x08).
export async function getDeviceViewingPrivateKey() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const execFileP = promisify(execFile);
  const HERE = dirname(fileURLToPath(import.meta.url));
  const { stdout } = await execFileP("python3", [join(HERE, "..", "tools", "apdu.py"), "e00800000100", "30"]);
  const m = stdout.match(/RESP\s+([0-9a-fA-F]+)/);
  if (!m) throw new Error(`device: no viewing key (${stdout.trim()})`);
  let hex = m[1];
  if (hex.endsWith("9000")) hex = hex.slice(0, -4);
  if (hex.length !== 64) throw new Error(`device: bad viewing key length (${hex})`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
