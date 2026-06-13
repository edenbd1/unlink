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
import { getDeviceSpendingPublicKey, deviceSignSigningRequest } from "./device-signer.mjs";

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
  return {
    ...reg,
    // UnlinkSpendSigner + registration provider, duck-typed for the SDK.
    getAddress: async () => reg.address,
    getPublicKey: async () => spendingPublicKey,
    getRegistrationPayload: async () => reg,
    signSigningRequest: deviceSignSigningRequest,
  };
}

// Ask the device to display the transfer (amount + recipient) and wait for a
// physical approval — BEFORE the tx is prepared, so the tap is outside the
// engine's prepare->submit window. Resolves true on approval, false on rejection.
export async function reviewIntentOnDevice(amount, recipient) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const execFileP = promisify(execFile);
  const HERE = dirname(fileURLToPath(import.meta.url));
  const payload = Buffer.concat([Buffer.from(amount, "utf8"), Buffer.from([0]), Buffer.from(recipient, "utf8")]);
  // e0 09 00 00 <Lc> <payload>
  const apduHex = "e0090000" + payload.length.toString(16).padStart(2, "0") + payload.toString("hex");
  const { stdout } = await execFileP("python3", [join(HERE, "..", "tools", "apdu.py"), apduHex, "120"]);
  const m = stdout.match(/RESP\s+([0-9a-fA-F]+)/);
  if (!m) throw new Error(`device: no review response (${stdout.trim()})`);
  return m[1].slice(-4) === "9000";
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
