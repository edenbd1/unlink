// A viem account whose Ethereum signatures come from the Ledger Ethereum app via
// @ledgerhq/hw-app-eth — which CLEAR-SIGNS: it resolves token/plugin descriptors
// from Ledger's CAL service so the device shows "Approve USDC" and the Permit2
// fields instead of a raw blind hash. Used so the Ledger's own ETH address signs
// the Permit2 deposit, shielding USDC straight from the device.
import { createRequire } from "module";
import { createWalletClient, createPublicClient, http, serializeTransaction, hashDomain, hashStruct, getTypesForEIP712Domain } from "viem";
import { toAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const require = createRequire(import.meta.url);
const Eth = require("@ledgerhq/hw-app-eth").default;
const { ledgerService } = require("@ledgerhq/hw-app-eth");
const TransportNodeHid = require("@ledgerhq/hw-transport-node-hid").default;

export const ETH_PATH = "44'/60'/0'/0/0";
const RPC = process.env.BASE_SEPOLIA_RPC || "https://base-sepolia-rpc.publicnode.com";

// Open a transport, run fn(eth), always close (so the Python poller / Unlink app
// can use the HID device afterwards). node-hid and the Python poller must never
// hold the device at the same time.
async function withEth(fn) {
  const transport = await TransportNodeHid.create();
  try { return await fn(new Eth(transport)); }
  finally { try { await transport.close(); } catch {} }
}

export async function getLedgerEthAddress() {
  return (await withEth((eth) => eth.getAddress(ETH_PATH, false))).address;
}

export async function ledgerEthClients() {
  const address = await getLedgerEthAddress();

  const account = toAccount({
    address,

    // Permit2 EIP-712. Uses the FAST hashed sign: full clear-signing here would
    // page through many screens and blow Unlink's deposit prepare->submit window
    // (same timeout class as transfers), so the recurring deposit stays quick.
    async signTypedData(params) {
      const types = params.types?.EIP712Domain
        ? params.types
        : { ...params.types, EIP712Domain: getTypesForEIP712Domain({ domain: params.domain }) };
      const domSep = hashDomain({ domain: params.domain, types });
      const structHash = hashStruct({ data: params.message, primaryType: params.primaryType, types });
      const sig = await withEth((eth) => eth.signEIP712HashedMessage(ETH_PATH, domSep, structHash));
      let v = Number(sig.v); if (v < 27) v += 27;
      return "0x" + sig.r + sig.s + v.toString(16).padStart(2, "0");
    },

    // Clear-signed transaction (the one-time Permit2 approve shows "Approve USDC").
    async signTransaction(tx, opts) {
      const serializer = opts?.serializer || serializeTransaction;
      const raw = serializer(tx).slice(2);
      const sig = await withEth(async (eth) => {
        const resolution = await ledgerService
          .resolveTransaction(raw, {}, { erc20: true, externalPlugins: true, nft: false })
          .catch(() => null);
        return eth.clearSignTransaction(ETH_PATH, raw, resolution || {}, true);
      });
      const v = parseInt(sig.v, 16);
      const r = "0x" + sig.r, s = "0x" + sig.s;
      const signature = tx.type && tx.type !== "legacy" ? { r, s, yParity: v % 2 } : { r, s, v: BigInt(v) };
      return serializer(tx, signature);
    },

    async signMessage() { throw new Error("signMessage via Ledger not wired"); },
  });

  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  return { account, walletClient, publicClient, address };
}
