import { createCustodiedSeed, decryptSeed, hasCustodiedSeed } from "../companion/gpg-custody.ts";
import { openSession, getBalances, depositFromWallet, privateTransfer } from "../companion/unlink.ts";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const recipientSeed = new Uint8Array(64); for (let i=0;i<64;i++) recipientSeed[i]=(i*13+5)&255;

console.log("1) Génère un seed Unlink + le chiffre vers le Ledger (OpenPGP)…");
await createCustodiedSeed(process.env.LEDGER_OPENPGP_RECIPIENT);
console.log("   seed.gpg créé:", hasCustodiedSeed());

console.log("2) Déchiffre le seed VIA LE LEDGER (le device peut demander confirmation)…");
const seed = await decryptSeed();
console.log("   seed déchiffré:", seed.length, "octets");

console.log("3) Ouvre la session Unlink (compte dérivé du seed custodié)…");
const s = await openSession(seed); seed.fill(0);
console.log("   adresse Unlink:", s.address);

console.log("4) Pré-enregistre le destinataire…");
const r = await openSession(recipientSeed);
console.log("   destinataire:", r.address);

console.log("5) Dépose 1 USDC réel dans le compte privé…");
const dep = await depositFromWallet(s, USDC, "1000000");
console.log("   deposit:", JSON.stringify(dep).slice(0,120));
await new Promise(res=>setTimeout(res,5000));
const bal = await getBalances(s);
console.log("   solde privé:", JSON.stringify(bal?.balances||bal));

console.log("6) Transfert PRIVÉ 0.3 USDC →", r.address.slice(0,18)+"…");
const tx = await privateTransfer(s, r.address, "300000", USDC);
console.log("   transfer:", JSON.stringify(tx).slice(0,160));
console.log("\n✅ CUSTODY LEDGER + VRAIE TX PRIVÉE — OK");
