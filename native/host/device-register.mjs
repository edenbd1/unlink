// Register the device-custodied Unlink account with the real Unlink backend.
// Proves the account assembled from the Ledger exports (spending public key +
// viewing key, spending key never leaving the SE) is accepted by the network.
//
// Run:  node --env-file=.env native/host/device-register.mjs
import { createUnlinkAdmin } from "@unlink-xyz/sdk/admin";
import { buildDeviceAccount } from "./device-account.mjs";

const ENVIRONMENT = process.env.UNLINK_ENVIRONMENT || "base-sepolia";
const API_KEY = process.env.UNLINK_API_KEY || "";
if (!API_KEY) throw new Error("UNLINK_API_KEY missing (run with --env-file=.env)");

console.log("→ assembling the device account…");
const acct = await buildDeviceAccount();
console.log("  address:", acct.address);

console.log(`→ registering with the Unlink backend (${ENVIRONMENT})…`);
const admin = createUnlinkAdmin({ environment: ENVIRONMENT, apiKey: API_KEY });
const payload = await acct.getRegistrationPayload();
await admin.users.register(payload);
console.log("\n✅ registered — the device-custodied account is live on Unlink.");
console.log("   spending key: in the Secure Element · viewing key: shared for reads · signing: on-device");
