// End-to-end demo of the device spend signer:
//   1. read the Unlink account public key from the device (GET_PUBLIC_KEY)
//   2. ask the device to sign a sample message hash as the SDK would
//      (deviceSignSigningRequest matches SignSigningRequestFn)
//   3. verify the EdDSA-Poseidon signature with the standalone verifier
//
// Run (with the device open on the Unlink app):  node native/host/device-demo.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDeviceSpendingPublicKey, deviceSignSigningRequest } from "./device-signer.mjs";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY_PY = join(HERE, "..", "tools", "verify.py");
const MSG = "42"; // sample Poseidon message hash (decimal)

console.log("→ reading Unlink public key from the device…");
const [Ax, Ay] = await getDeviceSpendingPublicKey();
console.log("  A.x =", Ax.toString());
console.log("  A.y =", Ay.toString());

console.log(`→ asking the device to sign message_hash=${MSG} (tap to approve if review is on)…`);
const { signature } = await deviceSignSigningRequest({ message_hash: MSG });
const [R8x, R8y, S] = signature;
console.log("  R8x =", R8x);
console.log("  R8y =", R8y);
console.log("  S   =", S);

console.log("→ verifying EdDSA-Poseidon signature…");
try {
  const { stdout } = await execFileP("python3", [VERIFY_PY, Ax.toString(), Ay.toString(), R8x, R8y, S, MSG]);
  console.log("  " + stdout.trim());
  console.log("\n✅ device produced a valid Unlink signature — ready to plug into the SDK as SignSigningRequestFn");
} catch (e) {
  console.error("\n❌ verification failed:", e.stdout || e.message);
  process.exit(1);
}
