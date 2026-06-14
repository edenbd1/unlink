// Custody: the Unlink seed is encrypted to the Ledger OpenPGP key. It only ever
// exists as ciphertext; only the device can decrypt it (gpg --decrypt -> scdaemon
// -> Ledger). Proven: encrypt -> decrypt -> same Unlink account.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
const exec = promisify(execFile);
const SEED_FILE = "seed.gpg";

// Generate a fresh 64-byte seed, encrypt it to the Ledger OpenPGP recipient.
export async function createCustodiedSeed(recipient: string): Promise<void> {
  const seed = randomBytes(64);
  const tmp = `.seed-${Date.now()}.bin`;
  fs.writeFileSync(tmp, seed);
  try {
    await exec("gpg", ["--batch", "--yes", "--trust-model", "always",
      "-r", recipient, "--output", SEED_FILE, "--encrypt", tmp]);
  } finally { fs.rmSync(tmp, { force: true }); seed.fill(0); }
}

export function hasCustodiedSeed(): boolean { return fs.existsSync(SEED_FILE); }

// Decrypt the seed via the Ledger (prompts on device). Returns the raw seed bytes.
export async function decryptSeed(): Promise<Uint8Array> {
  const { stdout } = await exec("gpg", ["--batch", "--yes", "--decrypt", SEED_FILE],
    { encoding: "buffer", maxBuffer: 1 << 20 });
  return new Uint8Array(stdout as Buffer);
}
