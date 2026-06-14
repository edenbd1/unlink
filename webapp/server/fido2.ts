// FIDO2 / WebAuthn gate. The Ledger Security Key app is a FIDO2 authenticator:
// every sensitive action requires a physical tap, verified here. In-memory store
// (single-user demo). rpID/origin default to localhost.
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";

const rpName = "Unlink";
const rpID = process.env.FIDO_RP_ID || "localhost";
const origin = process.env.FIDO_ORIGIN || "http://localhost:3000";

type Cred = { id: string; publicKey: Uint8Array; counter: number };
let credential: Cred | null = null;
let challenge: string | null = null;

export function isEnrolled() { return !!credential; }

export async function regOptions() {
  const opts = await generateRegistrationOptions({
    rpName, rpID, userName: "unlink-custody-owner",
    attestationType: "none",
    authenticatorSelection: { residentKey: "discouraged", userVerification: "discouraged" },
  });
  challenge = opts.challenge;
  return opts;
}

export async function regVerify(response: any) {
  if (!challenge) throw new Error("no challenge");
  const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
  if (!v.verified || !v.registrationInfo) throw new Error("registration failed");
  const { credential: c } = v.registrationInfo as any;
  credential = { id: c.id, publicKey: c.publicKey as Uint8Array, counter: c.counter };
  challenge = null;
  return { verified: true };
}

export async function authOptions() {
  if (!credential) throw new Error("not enrolled");
  const opts = await generateAuthenticationOptions({
    rpID, userVerification: "discouraged",
    allowCredentials: [{ id: credential.id }],
  });
  challenge = opts.challenge;
  return opts;
}

// Verify a tap. Returns true only on a fresh, valid assertion.
export async function authVerify(response: any) {
  if (!credential || !challenge) throw new Error("no pending tap");
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
    requireUserVerification: false,
    credential: { id: credential.id, publicKey: credential.publicKey as any, counter: credential.counter },
  });
  challenge = null;
  if (!v.verified) throw new Error("tap not verified");
  credential.counter = v.authenticationInfo.newCounter;
  return true;
}
