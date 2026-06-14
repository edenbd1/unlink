# Vision: private AI managed yield, custodied by Ledger

Notes for later. The pieces below build on what already works in this repo
(device custody, shield, private transfer, vault deposit via an Execution
Account).

## The pitch

Private yield managed by AI, custodied by your Ledger. You define a strategy with
an AI co-pilot, you approve it on your Ledger (the only thing that can move
funds), and verifiable AI agents execute and rebalance the yield while the
strategy and the positions stay confidential.

## Architecture (6 pieces)

### 1. Strategy co-pilot (AI agent number 1, advisory)
You describe your goals (risk, tokens, target APY) in plain language. The agent
proposes a concrete strategy: allocations across vaults, rebalancing rules,
thresholds. It can sign nothing. There is already a base in `server/copilot.ts`
(Claude), to extend toward yield.

### 2. Ledger approval (the custody gate)
When you validate the strategy, the Ledger signs two things:
* the initial deposit (Unlink shield into a vault via an EA), already working,
* a strategy mandate: a signature over the approved parameters (thresholds,
  allowed vaults, limits) that bounds what the agents are allowed to do.

### 3. Execution agents (AI agents number 2 and up, autonomous)
They watch the positions and rebalance within the approved mandate. The key idea:
the Ledger authorizes the strategy once (a policy plus the initial allocation),
not every rebalance. This is exactly Unlink's Execution Account model: you
authorize an EA with a spending policy through the Ledger, and the agents drive
the EA within that limit, with no tap on every move.

### 4. OpenPGP on the Ledger (strategy confidentiality)
The strategy, and the agents' operational secrets, are encrypted with the Ledger
OpenPGP app, so only your Ledger can decrypt them. The agents work on encrypted
strategy data and the sensitive parameters stay confidential. There is already a
flow in `companion/gpg-custody.ts`.

### 5. Confidential AI attestation
The agents run inside an attested environment (a TEE) and produce an attestation
that proves "this exact agent ran this exact strategy on this exact data". You
can verify that the AI did what was agreed: no drift, no leak of the strategy.

### 6. Chainlink CRE (the agents' runtime)
The Chainlink Runtime Environment runs the execution workflow in a decentralized,
verifiable way: it watches conditions (APY, prices), triggers the attested AI
decision, and executes the rebalance through the EA. Automation, the data oracle,
and the compute, in one.

## End to end flow

```
1. You plus the AI co-pilot      ->  a concrete strategy
2. strategy encrypted (Ledger OpenPGP)            [confidential]
3. you approve on the Ledger     ->  sign the initial deposit plus the mandate
4. funds shielded                ->  initial vault via the EA      [already done]
5. Chainlink CRE watches         ->  attested AI decision -> rebalance via the EA
6. every move produces an attestation             [auditable]
```

## Buildable now vs aspirational

| Piece | Status |
| --- | --- |
| Strategy co-pilot (AI) | buildable, base exists |
| Ledger approval plus deposit | done |
| Vault via EA | done |
| OpenPGP encryption of the strategy | buildable, flow exists |
| EA mandate plus auto rebalance | to design, the delicate custody point |
| Confidential AI attestation | external TEE integration |
| Chainlink CRE | external integration, CRE setup |

## Suggested MVP for a demo

A vertical slice: the co-pilot proposes a strategy, you approve it on the Ledger
(sign the deposit plus the mandate), one agent does a single rebalance (vault A to
vault B) through the EA, with the strategy encrypted via OpenPGP and a simple
attestation. Chainlink CRE and the full TEE come after.

Order to consider:
1. the strategy co-pilot (the AI that proposes, plus the Ledger mandate screen),
2. the rebalance via EA (vault A to vault B, autonomous),
3. the OpenPGP encryption of the strategy,
4. wiring Chainlink CRE first (the automation).
