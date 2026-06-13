// Full private-wallet demo driven by the Ledger device account:
//   register → faucet (private funding) → balances → transfer (signed on-device).
// The spending key never leaves the Secure Element.
//
// Run:  node --env-file=.env native/host/device-wallet-demo.mjs
import { createUnlinkAdmin } from "@unlink-xyz/sdk/admin";
import { createUnlinkClient } from "@unlink-xyz/sdk/client";
import { buildDeviceAccount } from "./device-account.mjs";

const ENVIRONMENT = process.env.UNLINK_ENVIRONMENT || "base-sepolia";
const API_KEY = process.env.UNLINK_API_KEY || "";
const USDC = process.env.DEMO_TOKEN || "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC
const AMOUNT = process.env.DEMO_AMOUNT || "1000000"; // 1 USDC (6 decimals)
if (!API_KEY) throw new Error("UNLINK_API_KEY missing (run with --env-file=.env)");

const log = (...a) => console.log(...a);

log("→ assembling the device account…");
const acct = await buildDeviceAccount();
log("  address:", acct.address);

const admin = createUnlinkAdmin({ environment: ENVIRONMENT, apiKey: API_KEY });
log(`→ registering on ${ENVIRONMENT}…`);
await admin.users.register(await acct.getRegistrationPayload());

const client = createUnlinkClient({
  environment: ENVIRONMENT,
  account: acct,
  authorizationToken: {
    provider: async ({ unlinkAddress }) => admin.authorizationTokens.issue({ unlinkAddress }),
  },
  register: async () => admin.users.register(await acct.getRegistrationPayload()),
});

const showBalances = async (label) => {
  const b = await admin.users.getBalances({ address: acct.address });
  log(`  ${label}:`, JSON.stringify(b?.balances ?? b));
};
await showBalances("balances (before)");

log("→ requesting private tokens from the faucet…");
try {
  await client.faucet.requestPrivateTokens({ token: USDC, amount: AMOUNT });
  log("  faucet ok — waiting for indexing…");
  await new Promise((r) => setTimeout(r, 6000));
  await showBalances("balances (after faucet)");
} catch (e) {
  log("  faucet skipped:", String(e.message || e));
}

log("→ private transfer (self), signed on the device…");
try {
  const handle = await client.transfer({ recipientAddress: acct.address, amount: AMOUNT, token: USDC });
  log("  transfer submitted:", JSON.stringify(handle)?.slice(0, 200));
  log("\n✅ device-signed private transfer executed — spending key stayed in the SE.");
} catch (e) {
  log("  transfer error:", String(e.message || e));
  process.exit(1);
}
