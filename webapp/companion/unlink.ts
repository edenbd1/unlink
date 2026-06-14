// Unlink client over a custodied seed. The seed (decrypted from the Ledger) IS
// the Unlink account: account.fromSeed keeps execute(). Verified flow: register
// the account with the tenant -> issue authorization tokens -> balances/transfer.
import { createUnlinkAdmin } from "@unlink-xyz/sdk/admin";
import { account, createUnlinkClient, evm } from "@unlink-xyz/sdk/client";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const ENVIRONMENT = process.env.UNLINK_ENVIRONMENT || "base-sepolia";
const API_KEY = process.env.UNLINK_API_KEY || "";
// Optional funding wallet: lets a user top up their private account from any EVM
// wallet (deposit into the unlink contract, crediting the custodied account).
const FUNDING_PK = process.env.FUNDING_PRIVATE_KEY || "";

export type Session = {
  client: ReturnType<typeof createUnlinkClient>;
  admin: ReturnType<typeof createUnlinkAdmin>;
  address: string;
};

// Build a live session from the decrypted seed.
export async function openSession(seed: Uint8Array): Promise<Session> {
  if (!API_KEY) throw new Error("UNLINK_API_KEY missing");
  const acct = await account.fromSeed({ seed });
  const keys = await (acct as any).loadKeys();
  const address: string = keys.address;

  const admin = createUnlinkAdmin({ environment: ENVIRONMENT, apiKey: API_KEY });
  // Register before issuing tokens (verified order: pass the account).
  await admin.users.register(await account.toRegistrationPayload(acct));

  // If a funding wallet is configured, attach it so deposits can credit this account.
  const evmProvider = FUNDING_PK
    ? evm.fromViem({
        walletClient: createWalletClient({
          account: privateKeyToAccount(FUNDING_PK as `0x${string}`),
          chain: baseSepolia,
          transport: http(),
        }),
        publicClient: createPublicClient({ chain: baseSepolia, transport: http() }),
      })
    : undefined;

  const client = createUnlinkClient({
    environment: ENVIRONMENT,
    account: acct,
    ...(evmProvider ? { evm: evmProvider } : {}),
    authorizationToken: {
      provider: async ({ unlinkAddress }: { unlinkAddress: string }) =>
        admin.authorizationTokens.issue({ unlinkAddress }),
    },
    // In-process register hook so the engine-side register resolves locally.
    register: async () => admin.users.register(await account.toRegistrationPayload(acct)),
  });

  return { client, admin, address };
}

// Fund the private account from the configured EVM wallet (approve + deposit).
export async function depositFromWallet(s: Session, token: string, amount: string) {
  if (!FUNDING_PK) throw new Error("no FUNDING_PRIVATE_KEY configured");
  return (s.client as any).depositWithApproval({ token, amount });
}

export async function getBalances(s: Session) {
  return s.admin.users.getBalances({ address: s.address });
}

// Private transfer to another registered Unlink address.
export async function privateTransfer(s: Session, recipientAddress: string, amount: string, token: string) {
  return s.client.transfer({ recipientAddress, amount, token });
}

// Request private test tokens (engine faucet).
export async function faucet(s: Session, token: string, amount: string) {
  return s.client.faucet.requestPrivateTokens({ token, amount });
}
