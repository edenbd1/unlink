# Debugging the on-device Unlink signer (Apex P) — journey & findings

Goal: the BOLOS app must compute an Unlink EdDSA-Poseidon signature **on the
Secure Element** that verifies under `@zk-kit/eddsa-poseidon`. It is byte-exact
correct on Speculos but was wrong on the physical Apex P. This log records why.

## What's proven correct on the real hardware
- The app runs on the Apex P (`GET_APP_NAME` returns "Unlink" live).
- **A (public key) and R8 are byte-EXACT correct on the device** — i.e. the
  scalar multiplications, projective point addition, and modular inversion all
  work. Verified by exporting the seed-derived key and recomputing on the host.
- Only **S** was wrong → isolated to the Poseidon challenge `hm`, since A and R8
  don't depend on Poseidon.

## Why the SE differs from Speculos: in-place cx_bn aliasing
The same binary is correct on Speculos but wrong on the SE. Root cause: some
`cx_bn_*` calls behave differently on the real SE when the **output aliases the
inputs**, which Speculos tolerates.

- ✅ `cx_bn_mod_mul(r,a,b)` with `r==a` (different b): works (used all over the
  point arithmetic, A/R8 correct).
- ✅ `cx_bn_mod_mul(r,a,a)` with `r` distinct (squaring into a new reg): works.
- ❌ `cx_bn_mod_mul(r,a,a)` with **`r==a==a` (all three the same register)**:
  **broken on the SE.** This is exactly `pow5`'s in-place square `fmul(o,o,o)`.
  Fixing it (square into a second register) changed the device output — the
  first confirmed device-specific bug.
- `cx_bn_mod_add(r,a,b)` with `r==a`: works (verified — the defensive rewrites
  were no-ops).

## Why this matters for a generic SE crypto port
The SE's hardware modular engine is fast but has stricter aliasing rules than
the software/emulated path. Any in-place `r==a==b` (notably in-place squaring)
must use a separate output register. The fix is mechanical once located.

## Status
pow5 fixed → Poseidon output moved (progress) but still not equal to the host →
at least one more subtle divergence. Currently pinpointing it by exporting the
full Poseidon state after a single round and diffing element-by-element against
the host reference.

## Update: pow5 fix confirmed, one more partial-round divergence suspected
- `pow5(7)` returned `1ab6134e…` instead of `16807` → confirmed the in-place
  square `cx_bn_mod_mul(o,o,o)` (r==a==b) is broken on the SE. Fixed with a 2nd
  output register. The full-Poseidon output then *changed* (4f4fb1e8 → 3e0fe2bc)
  — proof the fix took effect.
- A single clean **round-0** state export then matched the host on all 6
  elements. But the full 68-round output and the full signature still differed.
  → at least one more divergence, most likely exercised only in the **partial
  rounds** (x in [4,63], sbox on lane 0 only), which a single full round doesn't hit.
- Built a rounds-parameterized test (APDU data byte = number of rounds) to
  binary-search the first diverging round. **Blocker: the macOS HID pipe is too
  unstable** — repeated reads of the same deterministic value disagree, so the
  binary-search isn't reproducible here. On a Linux host (stable hidapi) or via
  BLE, the same test pinpoints the round deterministically.

## Bottom line
The hard crypto (BabyJubJub scalar mul, projective add, modular inverse) is
byte-exact on the device. One SE-aliasing class is found & fixed (in-place mul).
The remaining gap is a small, locatable Poseidon divergence — pending a stable
transport to finish the binary-search.

## RESOLVED ✅ — full signature byte-exact on hardware (Apex P)
The "remaining Poseidon divergence" was NOT a partial-round logic bug. It was a
second instance of the SAME SE cx_bn quirk: **`cx_bn_mod_add` / `cx_bn_mod_mul`
can leave the result in `[modulus, 2·modulus)` instead of fully reducing.**

Located by exporting the round-0 state in two slices:
- SBOX only (add C + pow5 all lanes) → byte-exact on all 6 lanes ✅
- SBOX + MIX (MDS accumulation) → `ns[i] == correct + P` on 5/6 lanes
  (`ns[3]` happened to land < P). `dev − host == P` exactly. Not congruence
  drift — a missing final subtraction.

Fix: `cx_bn_reduce(acc, R[16], P)` after each MDS accumulation step (restores the
`acc < P` invariant), and the same after the final `S = (r + hm·s) mod subOrder`
(it landed at `S_exp + subOrder` exactly).

Result — signing known vector 0 on the device returns, byte-exact vs the host:
```
Ax  111ad6eaff70758b7ad109a32526c54ae58eff19a8667f0b41b8c228f86588ee  ✅
Ay  1810293488974f0ae2d566a860d00c5bd24fc094b076e260e3b9b65b0555fb92  ✅
R8x 0afcb8a38dc22f29cdbda58c3ac10550734a791cf4fa00181efe1fad4af3febf  ✅
R8y 14ce4560b8c96fb075cd94a8e773a0ccfd49ece3d67f3c2764e8f7be04b4e64d  ✅
S   01f19b24c634473671fc821393051b631b338608675e489d7d05f6ab4fc55318  ✅
```
The Ledger native app signs Unlink EdDSA-Poseidon on the Secure Element, and the
signature verifies under `@zk-kit/eddsa-poseidon`.

### SE cx_bn rule of thumb (Apex P, SE 1.1.1)
Never trust `cx_bn_mod_add` / `cx_bn_mod_mul` to return a fully-reduced result.
After any accumulation chain, call `cx_bn_reduce(out, acc, modulus)`. And never
use `cx_bn_mod_mul(r, a, a, n)` with `r == a` (in-place square) — use a 2nd reg.
