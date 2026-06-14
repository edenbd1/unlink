# Chainlink CRE + Confidential AI Attester — private yield allocation

This is the Chainlink half of Lunave: a private DeFi yield agent custodied by a
Ledger. It targets two ETHGlobal NYC 2026 Chainlink prizes with **one pipeline**:

- **Best usage of Chainlink Confidential AI Attester** — the allocation inference
  runs inside a TEE on the user's PRIVATE financial profile.
- **Best workflow with CRE** — a CRE workflow turns that attested inference into a
  DON-signed on-chain report that gates the Execution Account.

```
Private profile (goals + capital + Unlink-pool balance)        sensitive
        │
        ▼   POST /v1/inference   (Authorization: Bearer <key from Chainlink desk>)
Chainlink Confidential AI Attester  ──  LLM runs INSIDE A TEE (AWS Nitro)
        │   output = allocation JSON  +  response_digest (SHA-256 provenance)
        ▼   cre_callback → CRE HTTP-trigger
CRE workflow  (yield-allocation-workflow/main.ts)
        │   transcriptHash = response_digest
        │   ABI-encode (user, vaults[], bps[], blendedApyBps, approved, transcriptHash, inferenceId)
        │   runtime.report(...)   ← DON-signed
        ▼   writeReport → KeystoneForwarder
AllocationGate.onReport   (contracts/AllocationGate.sol, Base Sepolia 84532)
        │   stores the DON-attested allocation, onlyForwarder
        ▼
Execution Account  only deploys / rebalances WITHIN the attested vaults + weights
```

Everything is on **Base Sepolia** (`ethereum-testnet-sepolia-base-1`, chainId 84532)
— the same chain as the Unlink vaults and the Execution Account.

## Layout

```
ledger/cre/
├── project.yaml                       CRE project (Base Sepolia RPC)
├── secrets.yaml                       maps INFERENCE_API_KEY → INFERENCE_API_KEY_VAR
├── .env.example                       CRE_ETH_PRIVATE_KEY, INFERENCE_API_KEY_VAR
├── foundry.toml
├── contracts/AllocationGate.sol       the on-chain consumer (onReport / onlyForwarder)
├── simulation/allocation-callback.json a canned Attester callback (for offline simulation)
├── simulation/inference-prompt.txt    the exact prompt the Attester is given
└── yield-allocation-workflow/
    ├── main.ts                        the CRE workflow (HTTP trigger → report → writeReport)
    ├── config.staging.json            consumerAddress, chainSelectorName, userAddress
    ├── workflow.yaml  package.json  tsconfig.json
```

The host-side client that calls the Attester directly (submit + poll) lives at
`ledger/host/confidential-ai.mjs`, wired into the web app's `/api/strategy/propose`.

## Prerequisites

- CRE CLI: `curl -sSL https://app.chain.link/cre/install.sh | bash` (installs `~/.cre/bin/cre`)
- Bun ≥ 1.2.21, Foundry (`forge`)
- `cd yield-allocation-workflow && bun install`
- Auth (one time): `cre login` (browser) or `export CRE_API_KEY=<key from app.chain.link>`
- For the live inference: `INFERENCE_API_KEY_VAR` from the Chainlink desk

## 1. Simulate the workflow (offline — no key, no wallet)

This is what the "Best workflow with CRE" prize needs (simulation is enough; the
Chainlink team deploys it for you). Run from this directory:

```bash
cre workflow simulate yield-allocation-workflow \
  --non-interactive \
  --trigger-index 0 \
  --http-payload ./simulation/allocation-callback.json
```

It compiles the workflow to WASM, feeds it the canned Attester callback, parses
the allocation, computes the transcriptHash, ABI-encodes the report, and prints
the result. The on-chain write is skipped without `--broadcast`.

## 2. Deploy AllocationGate (Base Sepolia)

```bash
forge create contracts/AllocationGate.sol:AllocationGate --broadcast \
  --rpc-url https://base-sepolia-rpc.publicnode.com \
  --private-key $CRE_ETH_PRIVATE_KEY \
  --constructor-args <BASE_SEPOLIA_KEYSTONE_FORWARDER>
```

Set `consumerAddress` in `yield-allocation-workflow/config.staging.json` to the
deployed address, and `userAddress` to the Ledger/Unlink user you attest for.

## 3. End-to-end live (Attester → CRE → on-chain)

```bash
# terminal A: local HTTP-trigger server + broadcast the on-chain write
cre workflow simulate yield-allocation-workflow --broadcast    # listens on http://localhost:2000/trigger
# terminal B: expose it
ngrok http 2000                                                # → https://<id>.ngrok-free.dev
# terminal C: submit one confidential inference, callback to the CRE trigger
curl -s -X POST https://confidential-ai-dev-preview.cldev.cloud/v1/inference \
  -H "Authorization: Bearer $INFERENCE_API_KEY_VAR" -H "Content-Type: application/json" \
  -d '{ "model":"gemma4", "system_prompt":"...", "prompt":"<private profile>",
        "cre_callback":{"url":"https://<id>.ngrok-free.dev/trigger"} }'
```

The Attester runs the inference in its TEE and POSTs the result to the CRE
trigger; the workflow signs it into a report and writes it to AllocationGate.

## Notes on what is real

- The TEE inference response carries **SHA-256 digests, not a signature**. The
  cryptographic, on-chain-verifiable signature is the **CRE DON report**, verified
  by the KeystoneForwarder before `onReport` runs — the consumer trusts
  `msg.sender == forwarder`, it does not ecrecover an attestor key itself.
- The non-broadcast simulation needs no deployed contract or funded wallet.
- Without an Attester API key, the web app falls back to a local strategy proposer
  with a locally-signed attestation, clearly labelled as a preview in the UI.
