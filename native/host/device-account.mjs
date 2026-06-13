// Reconstruct a full Unlink account from what the Ledger exports — the spending
// PUBLIC key (A) and the viewing PRIVATE key — without ever holding the spending
// private key (it stays in the Secure Element). Mirrors the SDK's buildAccountKeys
// derivation exactly:
//   viewingPublicKey = ed25519.getPublicKey(viewingPrivateKey)
//   nullifyingKey    = poseidon1([mod(viewingPrivateKey)])
//   masterPublicKey  = poseidon3([Ax, Ay, nullifyingKey])
//   address          = bech32m("unlink", [0] ++ BE32(masterPublicKey) ++ viewingPubKey)
// Signing is delegated to the device (deviceSignSigningRequest = SignSigningRequestFn).
import { ed25519 } from "@noble/curves/ed25519.js";
import { bech32m } from "@scure/base";
import { poseidon1, poseidon3 } from "poseidon-lite";
import { getDeviceSpendingPublicKey, deviceSignSigningRequest } from "./device-signer.mjs";

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const HRP = "unlink";
const VERSION = 0;

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

// Full device account: registration material + the device-backed spend signer.
export async function buildDeviceAccount() {
  const spendingPublicKey = await getDeviceSpendingPublicKey();
  const viewingPrivateKey = await getDeviceViewingPrivateKey();
  const reg = buildRegistration(spendingPublicKey, viewingPrivateKey);
  return {
    ...reg,
    // UnlinkSpendSigner + registration provider, duck-typed for the SDK.
    getAddress: async () => reg.address,
    getPublicKey: async () => spendingPublicKey,
    getRegistrationPayload: async () => reg,
    signSigningRequest: deviceSignSigningRequest,
  };
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
