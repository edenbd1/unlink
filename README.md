# Unlink — your private keys live in your Ledger

Private transactions on EVM where the **Unlink seed is encrypted to your Ledger
(OpenPGP)** — it only exists as ciphertext, only your device can decrypt it — and
every sensitive move requires a **physical tap (Ledger Security Key / FIDO2)**.

Ledger, two ways: **OpenPGP** custodies the key, **Security Key** authorizes the action.

## How it works

```
seed ──gpg --encrypt──► Ledger OpenPGP key      (the seed lives only as ciphertext)
unlock: gpg --decrypt ──► Ledger prompts on-device ──► seed in the local companion
private action ──► tap on Ledger (Security Key / FIDO2) ──► Unlink executes (private)
```

- **OpenPGP** = custody. The seed is encrypted to the device; only the Ledger decrypts it.
- **Security Key (FIDO2)** = approval. Nothing moves without a physical tap.
- **Unlink** = the private engine (balances / transfers, unlinkable on-chain).

## Run

```bash
npm install
cp .env.example .env     # UNLINK_API_KEY + your Ledger OpenPGP key id
npm run dev:all          # web :3000 + local companion :8787
```

On the Ledger (Ledger Live → My Ledger, developer mode): install **OpenPGP** and
**Security Key** apps.

Built at ETHGlobal NYC 2026.
