# Port C du signer Unlink (on-device, Aleo-grade)

Le signer Unlink = **`@zk-kit/eddsa-poseidon`** (PUBLIC, pas de spec secret). Validé :
les clés du SDK == `derivePublicKey` de zk-kit. Test vectors dans `test-vectors.json`.

## L'algorithme exact (à reproduire byte-exact en C)
```
deriveSecretScalar(sk):  h = Blake2b(sk); s = pruneBuffer(h[0:32])   // scalaire de signe
A  = (s >> 3) · Base8                                                 // public key
r  = Blake2b(h[32:64] ‖ msg_le32) mod subOrder
R8 = r · Base8
hm = Poseidon5(R8x, R8y, Ax, Ay, msg)                                 // challenge (Poseidon t=6)
S  = (r + hm · s) mod subOrder
signature = { R8:[R8x,R8y], S }
```

## Primitives à porter en BOLOS C
| Primitive | Détail | Source C réutilisable |
|---|---|---|
| **Blake2b** | dérivation du secret + nonce r | impl C ultra-standard (RFC 7693) |
| **BabyJubJub** | twisted Edwards / BN254 ; `mulPointEscalar` (Base8·k), add | iden3/circomlib C, ou port depuis circomlibjs |
| **Poseidon (t=6)** | challenge `hm` ; params circomlib publics | impl C Poseidon (constantes circomlib) |
| **F arithmétique** | mod `subOrder` (sous-groupe) + field BN254 `p` | cx_math_* (bignum SE) ou Montgomery C |
| **pruneBuffer** | clear 3 bits bas, set bit haut | trivial |

Constantes publiques : `p (BN254) = 21888242871839275222246405745257275088548364400416034343698204186575808495617`,
BabyJubJub `Base8`, `subOrder`, params Poseidon circomlib (t=6).

## Scope minimal vs sécurisé
- **Minimal (signe un message_hash donné)** : juste l'algo ci-dessus → {R8,S}. Le host calcule message_hash.
- **Sécurisé (clear-sign)** : le device recalcule aussi `message_hash` depuis les `publicInputs`
  (Poseidon de merkle_root/nullifiers/commitments) pour afficher ce qui est dépensé. + de Poseidon.

## Build/test sans certification
- **Speculos** (émulateur) : build + run + valider contre `test-vectors.json`. Zéro device, zéro cert.
- **Sideload** : `ledgerctl install` sur Nano S Plus (non-signé, dev mode).
- Scaffold : fork `LedgerHQ/app-boilerplate` (APDU + UI) ; s'inspirer de `LedgerHQ/app-aleo`
  (`src/crypto/poseidon.c`, `group.c`, `account/signature.c`) — même pattern, autre courbe.

## Validation
Le port C est correct quand, pour chaque vector : `sign(sk, msg)` produit exactement `{R8x, R8y, S}`.
