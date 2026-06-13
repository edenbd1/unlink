#!/usr/bin/env bash
# Build the Unlink BOLOS app, run it on Speculos, and check the on-device
# signature is byte-exact to the reference @zk-kit/eddsa-poseidon signer.
set -e
cd "$(dirname "$0")/.."
IMG=ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest
echo "› build (Nano S Plus)…"
docker run --rm -v "$(pwd):/repo" $IMG bash -c "cd /repo/native/app && make -j TARGET=nanos2 >/dev/null 2>&1"
echo "› speculos…"
docker rm -f speculos >/dev/null 2>&1 || true
docker run --rm -d --name speculos -v "$(pwd)/native/app/bin:/app" -p 5001:5000 \
  ghcr.io/ledgerhq/speculos:latest --model nanosp --display headless --api-port 5000 /app/app.elf >/dev/null 2>&1
sleep 7
# GET_PUBLIC_KEY (E0 05 00 00 01 00) -> Ax|Ay|R8x|R8y|S signed on the SE for the test key
RESP=$(curl -s -m 15 -X POST localhost:5001/apdu -H 'Content-Type: application/json' -d '{"data":"e00500000100"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data'])")
docker rm -f speculos >/dev/null 2>&1 || true
EXP="001473fa01b039954b46dc3d0f8dd6bf23581ce8a559c62982cf843453a49541062a87eb4c44078d6c49c0281e8f44560ca29611936726703f6d56aea152d9052779775eeee0f0449355a9c4ee7b86dfa095f1283ef6479d76322fd89b394c6815bf9d97dda5dd20f01887de2a5d47c1729aeff4b1a5b2e4db0d57b15b5ee9d402f31331f4c87d94b0a6963481433a1cf81b1c9f509ace395ba841ad5acc4e6e9000"
if [ "$(echo $RESP | tr A-Z a-z)" = "$EXP" ]; then echo "✅ on-device signature == reference signer (byte-exact)"; else echo "❌ mismatch: $RESP"; exit 1; fi
