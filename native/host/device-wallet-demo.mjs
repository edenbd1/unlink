// Full private-wallet demo driven by the Ledger device account:
//   register → faucet (private funding) → balances → transfer (signed on-device).
// The spending key never leaves the Secure Element.
//
// Run:  node --env-file=.env native/host/device-wallet-demo.mjs
import { createUnlinkAdmin } from "@unlink-xyz/sdk/admin";
import { createUnlinkClient, evm, account as sdkAccount } from "@unlink-xyz/sdk/client";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { buildDeviceAccount } from "./device-account.mjs";

const ENVIRONMENT = process.env.UNLINK_ENVIRONMENT || "base-sepolia";
const API_KEY = process.env.UNLINK_API_KEY || "";
const FUNDING_PK = process.env.FUNDING_PRIVATE_KEY || "";
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

const evmProvider = FUNDING_PK
  ? evm.fromViem({
      walletClient: createWalletClient({ account: privateKeyToAccount(FUNDING_PK), chain: baseSepolia, transport: http() }),
      publicClient: createPublicClient({ chain: baseSepolia, transport: http() }),
    })
  : undefined;

const client = createUnlinkClient({
  environment: ENVIRONMENT,
  account: acct,
  ...(evmProvider ? { evm: evmProvider } : {}),
  authorizationToken: {
    provider: async ({ unlinkAddress }) => admin.authorizationTokens.issue({ unlinkAddress }),
  },
  register: async () => admin.users.register(await acct.getRegistrationPayload()),
});

const balanceOf = async () => {
  const b = await admin.users.getBalances({ address: acct.address });
  const list = b?.balances ?? b ?? [];
  const row = list.find?.((x) => (x.token || "").toLowerCase() === USDC.toLowerCase());
  return BigInt(row?.amount || "0");
};
const XFER = process.env.DEMO_XFER || "500000"; // 0.5 USDC
log("  balance (before):", (await balanceOf()).toString());

if ((await balanceOf()) < BigInt(XFER)) {
  log("→ funding the device account (deposit from the EVM wallet, approve + deposit)…");
  try {
    await client.depositWithApproval({ token: USDC, amount: AMOUNT });
    log("  deposit submitted — waiting for indexing…");
    await new Promise((r) => setTimeout(r, 12000));
    log("  balance (after deposit):", (await balanceOf()).toString());
  } catch (e) {
    log("  deposit skipped:", String(e.message || e));
  }
} else {
  log("  already funded — skipping deposit (keeps the device awake for signing)");
}

log("→ creating + registering a recipient account…");
const recipient = await sdkAccount.fromSeed({ seed: Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff) });
await admin.users.register(await sdkAccount.toRegistrationPayload(recipient));
const recipientAddress = await recipient.getAddress();
log("  recipient:", recipientAddress);

// Verify every device signature locally, against the registered pubkey, as the
// transfer asks for it — pinpoints whether a failure is signature- or engine-side.
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const { fileURLToPath } = await import("node:url");
const { dirname, join } = await import("node:path");
const execFileP = promisify(execFile);
const VERIFY_PY = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "verify.py");
const [Ax, Ay] = acct.spendingPublicKey;
const innerSign = acct.signSigningRequest;
acct.signSigningRequest = async (req) => {
  const res = await innerSign(req);
  const [R8x, R8y, S] = res.signature;
  try {
    const { stdout } = await execFileP("python3", [VERIFY_PY, Ax.toString(), Ay.toString(), R8x, R8y, S, String(req.message_hash)]);
    log(`    device sig over message_hash=${String(req.message_hash).slice(0, 12)}… → ${stdout.trim()}`);
  } catch (e) {
    log(`    device sig LOCAL VERIFY FAILED: ${(e.stdout || "").trim()}`);
  }
  return res;
};

log(`→ private transfer ${XFER} to the recipient, signed on the device…`);
try {
  const handle = await client.transfer({
    recipientAddress, amount: XFER, token: USDC,
    onStatus: (status, txId) => log(`    status: ${status} (${txId})`),
  });
  log("  transfer submitted:", JSON.stringify(handle)?.slice(0, 200));
  await new Promise((r) => setTimeout(r, 8000));
  log("  balance (after transfer):", (await balanceOf()).toString());
  log("\n✅ device-signed private transfer executed — spending key stayed in the SE.");
} catch (e) {
  log("  transfer error:", String(e.message || e));
  process.exit(1);
}
