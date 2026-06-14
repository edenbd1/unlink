// A viem account whose Ethereum signatures come from the Ledger Ethereum app
// (via tools/eth_apdu.py over the Python HID poller — no native node-hid build).
// Used so the Ledger's own ETH address signs the Permit2 deposit (and the
// one-time Permit2 approval), shielding USDC straight from the device.
import { createWalletClient, createPublicClient, http, hashDomain, hashStruct, serializeTransaction, getTypesForEIP712Domain } from "viem";
import { toAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileP = promisify(execFile);
const ETH_PY = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "eth_apdu.py");
export const ETH_PATH = "44'/60'/0'/0/0";

async function eth(...args) {
  const { stdout } = await execFileP("python3", [ETH_PY, ...args], { maxBuffer: 1 << 20 });
  return stdout.trim().split("\n").pop().trim();
}

export async function getLedgerEthAddress() {
  return await eth("get_address", ETH_PATH);
}

// Build a viem wallet/public client pair backed by the Ledger ETH app.
export async function ledgerEthClients() {
  const address = await getLedgerEthAddress();

  const account = toAccount({
    address,

    async signTypedData(params) {
      const types = params.types?.EIP712Domain
        ? params.types
        : { ...params.types, EIP712Domain: getTypesForEIP712Domain({ domain: params.domain }) };
      const domainSep = hashDomain({ domain: params.domain, types });
      const structHash = hashStruct({ data: params.message, primaryType: params.primaryType, types });
      const sig = await eth("sign712", ETH_PATH, domainSep.slice(2), structHash.slice(2)); // 0x r||s||v
      const b = sig.slice(2);
      let v = parseInt(b.slice(128, 130), 16); if (v < 27) v += 27;          // normalize recovery id
      return "0x" + b.slice(0, 128) + v.toString(16).padStart(2, "0");
    },

    async signTransaction(tx, opts) {
      const serializer = opts?.serializer || serializeTransaction;
      const unsigned = serializer(tx);
      const packed = await eth("sign_tx", ETH_PATH, unsigned.slice(2)); // 0x v(1) r(32) s(32)
      const b = packed.slice(2);
      const v = parseInt(b.slice(0, 2), 16);
      const r = "0x" + b.slice(2, 66);
      const s = "0x" + b.slice(66, 130);
      // EIP-1559 / typed txs use yParity (0/1); legacy uses v.
      const signature = tx.type && tx.type !== "legacy" ? { r, s, yParity: v & 1 } : { r, s, v: BigInt(v) };
      return serializer(tx, signature);
    },

    async signMessage() { throw new Error("signMessage via Ledger not wired"); },
  });

  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  return { account, walletClient, publicClient, address };
}
