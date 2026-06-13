// Minimal software FIDO2 authenticator (ES256, "none" attestation) to drive the
// WebAuthn gate end-to-end without hardware. Mirrors what the Ledger Security Key
// app produces: a P-256 assertion over (authData || sha256(clientDataJSON)).
import { createSign, generateKeyPairSync, createHash, randomBytes } from "node:crypto";

const b64url = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();

// --- tiny CBOR encoder (just what attestation/COSE need) ---
const head = (major, n) => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  throw new Error("cbor too big");
};
const cbInt = (n) => (n >= 0 ? head(0, n) : head(1, -1 - n));
const cbBytes = (b) => Buffer.concat([head(2, b.length), b]);
const cbText = (s) => Buffer.concat([head(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cbMap = (pairs) => Buffer.concat([head(5, pairs.length), ...pairs.flatMap(([k, v]) => [k, v])]);

export function createAuthenticator(rpID = "localhost", origin = "http://localhost:3000") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url"), y = Buffer.from(jwk.y, "base64url");
  const credId = randomBytes(16);
  const rpIdHash = sha256(rpID);
  let counter = 0;

  // COSE_Key: {1:2(EC2), 3:-7(ES256), -1:1(P-256), -2:x, -3:y}
  const cose = cbMap([
    [cbInt(1), cbInt(2)], [cbInt(3), cbInt(-7)],
    [cbInt(-1), cbInt(1)], [cbInt(-2), cbBytes(x)], [cbInt(-3), cbBytes(y)],
  ]);

  const authData = (flags) => {
    const c = Buffer.alloc(4); c.writeUInt32BE(++counter);
    let buf = Buffer.concat([rpIdHash, Buffer.from([flags]), c]);
    if (flags & 0x40) { // attested credential data present
      const aaguid = Buffer.alloc(16);
      const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
      buf = Buffer.concat([buf, aaguid, idLen, credId, cose]);
    }
    return buf;
  };

  const register = (options) => {
    const clientData = Buffer.from(JSON.stringify({
      type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false,
    }));
    const ad = authData(0x41); // UP + AT
    const attObj = cbMap([
      [cbText("fmt"), cbText("none")],
      [cbText("attStmt"), cbMap([])],
      [cbText("authData"), cbBytes(ad)],
    ]);
    return {
      id: b64url(credId), rawId: b64url(credId), type: "public-key",
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attObj), transports: ["usb"] },
      clientExtensionResults: {}, authenticatorAttachment: "cross-platform",
    };
  };

  const authenticate = (options) => {
    const clientData = Buffer.from(JSON.stringify({
      type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false,
    }));
    const ad = authData(0x01); // UP only
    const sig = createSign("SHA256").update(Buffer.concat([ad, sha256(clientData)])).sign(privateKey); // DER
    return {
      id: b64url(credId), rawId: b64url(credId), type: "public-key",
      response: { authenticatorData: b64url(ad), clientDataJSON: b64url(clientData), signature: b64url(sig) },
      clientExtensionResults: {},
    };
  };

  return { register, authenticate };
}
