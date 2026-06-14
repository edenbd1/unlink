# Unlink native app — host bridge

The Ledger Apex P runs the Unlink native app: the EdDSA-Poseidon **spending key
is derived in the Secure Element and never leaves it**. This folder bridges that
device to the Unlink SDK.

## APDU protocol (CLA `0xE0`)

| INS    | Name           | cdata                  | response                         | UI    |
|--------|----------------|------------------------|----------------------------------|-------|
| `0x05` | GET_PUBLIC_KEY | 1 byte (ignored)       | `Ax|Ay` (64B)                    | none  |
| `0x06` | SIGN_TX        | 32B message hash (BE)  | `Ax|Ay|R8x|R8y|S` (160B)         | review + tap |

All integers are 32-byte big-endian. The signature verifies under
`@zk-kit/eddsa-poseidon` (`S·B8 == R8 + 8·hm·A`, `hm = Poseidon5(R8x,R8y,Ax,Ay,msg)`).

## Bridge (`device-signer.mjs`)

```js
import { getDeviceSpendingPublicKey, deviceSignSigningRequest } from "./device-signer.mjs";

const [Ax, Ay] = await getDeviceSpendingPublicKey();        // the account public key
const { signature } = await deviceSignSigningRequest(req);  // req.message_hash -> [R8x,R8y,S]
```

`deviceSignSigningRequest` matches the SDK's `SignSigningRequestFn`, so it drops
straight into the transfer/withdraw builders. Transport shells to
`../tools/apdu.py` (the macOS HID poller that survives the unstable USB pipe).

Demo (device open on the Unlink app):

```
node native/host/device-demo.mjs
```

reads the pubkey, signs a sample hash, and verifies it with `../tools/verify.py`.
Proven on hardware: `verify=True on_curve=True`.

## Status

- **Done & proven on the Apex P:** key derived in the SE, GET_PUBLIC_KEY, SIGN
  with on-device review, signature verifies; bridge returns SDK-shaped output.
- **Remaining for a full SDK `transfer`:** an Unlink account carries four key
  components (spending, viewing, nullifying, master). The device owns the
  **spending** half (the signing authority). To run the high-level client end to
  end, the viewing key (a read/decrypt capability — shareable under consent, as
  Aleo does) and the public nullifying/master keys must also be available host
  side: either exported from the device or derived from the same seed. The
  spending-signer — the security-critical custody piece — is complete here.
