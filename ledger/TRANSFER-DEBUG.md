# Device-custodied transfer — RESOLVED ✅

## Resolution
A device-signed private transfer now completes end-to-end on the live Unlink
backend (base-sepolia): status **`processed`**, balance debited. The
spending key never left the Secure Element.

```
transfer  processed  22:47:57   (txId 2f1e5fa2-41ac-4090-9432-2cbd56d0aa12)
balance: 2.0 USDC -> 1.5 USDC   (0.5 sent, device-signed)
```

## Root cause — it was SPEED, not crypto
The signature was always correct (SDK `verifySignature` = true, byte-exact vs
`signMessage`). The transfer failed because the **device took 65 s to sign**, and
Unlink's engine has a validity window between `prepare` and `submit`. The
prepared transaction expired before the signature came back → `failed`.

Proof: injecting a 65 s delay before submit made a **pure SDK software account**
(which normally succeeds) fail with the *exact same* error. A 30 s delay
succeeded. So the threshold sits between 30 s and 65 s.

## Fix — fixed-base comb (65 s → 26 s)
Both scalar muls (A and R8) use the same constant base B8, so we replaced the
256-doubling double-and-add with a **Lim-Lee fixed-base comb** (h=8, d=32):
32 doublings + ≤32 mixed adds, table precomputed host-side
(`src/unlink_comb.h`, 256 points, validated `comb_mul == k·B8`). Also added a
dedicated twisted-Edwards **doubling** formula (`dblProj`).

Subtle gotcha (same SE class as before): the first `dblProj` had an
`fmul(Y3, F, Y3)` — output aliases the *second* operand (`r == b`), which the SE
miscomputes. Rewrote so every `fmul` output is distinct from its inputs. After
that the comb signature verifies byte-exact and signing is 26 s — under the
engine window — and the transfer is accepted and processed.

## Takeaway
The native Ledger app signs Unlink in ~26 s, and a private transfer custodied
entirely by the device works end-to-end on the real network.
