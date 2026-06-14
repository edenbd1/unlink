// Assemble the full Unlink account from the Ledger and prove it can sign — with
// the spending private key never leaving the Secure Element.
//   1. read spending public key (GET_PUBLIC_KEY) + viewing private key (GET_VIEWING_KEY)
//   2. reconstruct the account (address, nullifyingKey, registration material)
//   3. sign a sample request via the device and verify it
//
// Run (device open on the Unlink app):  node native/host/device-account-demo.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDeviceAccount } from "./device-account.mjs";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY_PY = join(HERE, "..", "tools", "verify.py");
const MSG = "42";

console.log("→ assembling the Unlink account from the device…");
const acct = await buildDeviceAccount();
console.log("  address        :", acct.address);
console.log("  spendingPubKey :", acct.spendingPublicKey[0].toString().slice(0, 16) + "…");
console.log("  nullifyingKey  :", acct.nullifyingKey.toString().slice(0, 16) + "…");
console.log("  viewingPrivKey : (32 bytes, read capability — stays a read key)");

console.log(`→ signing a sample request (message_hash=${MSG}) via the device…`);
const { signature } = await acct.signSigningRequest({ message_hash: MSG });
const [R8x, R8y, S] = signature;

console.log("→ verifying the signature under the account public key…");
const [Ax, Ay] = acct.spendingPublicKey;
const { stdout } = await execFileP("python3", [VERIFY_PY, Ax.toString(), Ay.toString(), R8x, R8y, S, MSG]);
console.log("  " + stdout.trim());
console.log("\n✅ device-custodied Unlink account — address derived, signs & verifies. Spending key never left the SE.");
