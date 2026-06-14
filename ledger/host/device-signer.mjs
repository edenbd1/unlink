// Bridge: a Ledger Apex P running the Unlink native app, exposed as an Unlink
// SDK spend signer. The spending private key lives in the Secure Element and
// never leaves it; this module only ships the message hash to the device and
// reads back the EdDSA-Poseidon signature.
//
//   getDeviceSpendingPublicKey()      -> [Ax, Ay]                (bigint pair)
//   deviceSignSigningRequest(req)     -> { signature: [R8x,R8y,S] }  (decimal strings)
//
// deviceSignSigningRequest matches the SDK's `SignSigningRequestFn`, so it can be
// dropped straight into transfer/withdraw builders (req.message_hash is the
// Poseidon hash to sign, as a decimal string).
//
// Transport: shells out to tools/apdu.py — the macOS HID poller that reliably
// survives the unstable USB pipe (node-hid was not dependable here).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const APDU_PY = join(HERE, "..", "tools", "apdu.py");

const CLA = "e0";
const INS_GET_PUBKEY = "05";
const INS_SIGN = "06";

function toBE32Hex(decimalOrHex) {
  const v = BigInt(/^0x/.test(decimalOrHex) ? decimalOrHex : decimalOrHex); // BigInt() accepts decimal & 0x
  return v.toString(16).padStart(64, "0");
}

async function sendAPDU(apduHex, timeoutSec = 200) {
  const { stdout } = await execFileP("python3", [APDU_PY, apduHex, String(timeoutSec)]);
  const m = stdout.match(/RESP\s+([0-9a-fA-F]+)/);
  if (!m) throw new Error(`device: no response (${stdout.trim()})`);
  let hex = m[1];
  if (hex.endsWith("9000")) hex = hex.slice(0, -4);
  const sw = m[1].slice(-4);
  if (sw !== "9000") throw new Error(`device: APDU error ${sw}`);
  return hex;
}

// A = (Ax, Ay): the Unlink account public spending key derived in the SE.
export async function getDeviceSpendingPublicKey() {
  const hex = await sendAPDU(`${CLA}${INS_GET_PUBKEY}00000100`, 90);
  if (hex.length < 128) throw new Error(`device: short pubkey (${hex})`);
  return [BigInt("0x" + hex.slice(0, 64)), BigInt("0x" + hex.slice(64, 128))];
}

// SignSigningRequestFn: ask the device to sign req.message_hash. Shows the
// on-device review and waits for the physical tap (unless the app was built with
// UNLINK_IMMEDIATE_SIGN). Returns the signature as decimal strings.
export async function deviceSignSigningRequest(req) {
  if (!req || req.message_hash == null) throw new Error("missing req.message_hash");
  const hashHex = toBE32Hex(String(req.message_hash));
  const apdu = `${CLA}${INS_SIGN}000020${hashHex}`;
  const hex = await sendAPDU(apdu, 240);
  if (hex.length < 320) throw new Error(`device: short signature (${hex})`);
  // layout: Ax | Ay | R8x | R8y | S  (32 bytes each, big-endian)
  const R8x = BigInt("0x" + hex.slice(128, 192)).toString();
  const R8y = BigInt("0x" + hex.slice(192, 256)).toString();
  const S = BigInt("0x" + hex.slice(256, 320)).toString();
  return { signature: [R8x, R8y, S] };
}
