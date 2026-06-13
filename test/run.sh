#!/usr/bin/env bash
# Self-contained e2e: temp GPG key (Ledger OpenPGP curve) → boot server → drive flow.
set -e
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "need .env with UNLINK_API_KEY"; exit 1; }

export GNUPGHOME="$(mktemp -d)"
trap 'kill $SRV 2>/dev/null; rm -rf "$GNUPGHOME"; rm -f seed.gpg' EXIT
cat > "$GNUPGHOME/spec" <<KEY
%no-protection
Key-Type: eddsa
Key-Curve: ed25519
Subkey-Type: ecdh
Subkey-Curve: cv25519
Name-Real: Ledger OpenPGP (sim)
Name-Email: custody@unlink.test
Expire-Date: 0
%commit
KEY
gpg --batch --gen-key "$GNUPGHOME/spec" 2>/dev/null
export LEDGER_OPENPGP_RECIPIENT="$(gpg --list-keys --with-colons custody@unlink.test | awk -F: '/^pub/{print $5; exit}')"
echo "Ledger OpenPGP key (sim): $LEDGER_OPENPGP_RECIPIENT"

rm -f seed.gpg
node --env-file=.env --experimental-strip-types server/index.ts > /tmp/unlink-e2e-srv.log 2>&1 &
SRV=$!
for i in $(seq 1 20); do curl -s localhost:8787/api/custody/status >/dev/null 2>&1 && break; sleep 0.3; done

LEDGER_OPENPGP_RECIPIENT="$LEDGER_OPENPGP_RECIPIENT" node --env-file=.env --experimental-strip-types test/e2e.mjs
