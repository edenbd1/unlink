# lunave

Private DeFi custodied by Ledger. The Unlink spending key is generated inside the
Ledger Secure Element and never leaves it. The device itself signs the private
transactions, and every move is approved on screen.

This is a monorepo with two parts.

## `ledger/` — native Ledger custody (the main work)

A BOLOS Ledger app that signs Unlink EdDSA-Poseidon on the Secure Element, a host
bridge that exposes the device as the Unlink SDK signer, and a localhost front to
shield USDC, send privately, and deposit into an ERC-4626 vault through an
Execution Account. The spending key never leaves the chip.

```
ledger/app        the BOLOS Ledger app (the on chip Unlink signer)
ledger/host       the host bridge (device account, signer, Ethereum app)
ledger/web        the localhost test front and its server
ledger/tools      verify.py, apdu.py, eth_apdu.py
ledger/contracts  a minimal ERC-4626 demo vault
```

See `ledger/README.md` for the full design, and `ledger/SE-DEBUG.md`,
`ledger/TRANSFER-DEBUG.md`, `ledger/AI-YIELD-AGENT.md` for the engineering notes
and the AI managed yield direction.

```bash
npm install
cp .env.example .env     # UNLINK_API_KEY, UNLINK_ENVIRONMENT, FUNDING_PRIVATE_KEY
npm run web              # device test front on http://localhost:8799
```

## `webapp/` — OpenPGP custody web app (the earlier approach)

Before the native app, the same goal was reached a different way: the Unlink seed
encrypted to the Ledger with OpenPGP, decrypted on the device, and a FIDO2 tap to
authorize each action.

```
webapp/src         the React front
webapp/server      the Hono backend (custody, FIDO2, AI co-pilot)
webapp/companion   OpenPGP custody plus the Unlink SDK wrapper
```

```bash
npm run dev:all          # web on :3000 plus the companion API on :8787
```

The native app supersedes it: instead of encrypting a software seed to the
device, the key is generated and used inside the Secure Element and never exists
in software at all.

## Security

The Unlink tenant API key is read server side only (`process.env.UNLINK_API_KEY`).
It is never sent to the browser or to the Ledger. The Ledger only holds the
spending key, in the Secure Element. The `.env` file and the host key cache are
gitignored.

Built at ETHGlobal NYC 2026.
