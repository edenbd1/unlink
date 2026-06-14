#!/usr/bin/env bash
# Build the Unlink BOLOS app, run it on Speculos, trigger the on-device review,
# approve it (buttons), and check the seed-derived on-device signature verifies
# under the reference @zk-kit/eddsa-poseidon.
set -e
cd "$(dirname "$0")/.."
IMG=ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest
echo "› build (Nano S Plus)…"
docker run --rm -v "$(pwd):/repo" $IMG bash -c "cd /repo/native/app && make -j TARGET=nanos2 >/dev/null 2>&1"
echo "› speculos…"
docker rm -f speculos >/dev/null 2>&1 || true
docker run --rm -d --name speculos -v "$(pwd)/native/app/bin:/app" -p 5001:5000 \
  ghcr.io/ledgerhq/speculos:latest --model nanosp --display headless --api-port 5000 /app/app.elf >/dev/null 2>&1
sleep 8
press(){ curl -s -m 5 -X POST localhost:5001/button/$1 -H 'Content-Type: application/json' -d '{"action":"press-and-release"}' >/dev/null; sleep 1; }
curl -s -m 40 -X POST localhost:5001/apdu -H 'Content-Type: application/json' -d '{"data":"e00500000100"}' > /tmp/apdu_resp.json 2>&1 &
PID=$!; sleep 4
press right; press right; press right; press both   # navigate + approve
wait $PID
docker rm -f speculos >/dev/null 2>&1 || true
RESP=$(python3 -c "import json;print(json.load(open('/tmp/apdu_resp.json')).get('data',''))")
node --input-type=module -e "
import * as S from './node_modules/@unlink-xyz/sdk/dist/eddsa-poseidon-blake-2b-2AP2O5KZ.js';
let r='$RESP'.toLowerCase().replace(/9000\$/,'');
const f=i=>BigInt('0x'+r.slice(i*64,(i+1)*64));
const A=[f(0),f(1)], sig={R8:[f(2),f(3)], S:f(4)};
const ok=S.verifySignature(42n, sig, A);
console.log(ok?'✅ on-device signature (after physical approval) verifies':'❌ invalid');
process.exit(ok?0:1);
"
