// Seal the agent's MANDATE to the Ledger OpenPGP key.
//
// The mandate is the autonomy the agent runs under: which vaults, the rebalance
// trigger, the cap per vault. Encrypted to the device's OpenPGP key, it only ever
// exists as ciphertext and can only be opened with the physical Ledger present
// (gpg --decrypt -> scdaemon -> Ledger, PIN on device). So the rules the agent
// obeys are themselves under hardware custody: nobody can read or rewrite the
// mandate without the device. Same primitive the earlier webapp used to custody
// the Unlink seed (webapp/companion/gpg-custody.ts).
//
// Setup (one time): install the OpenPGP app on the Ledger, generate/import a PGP
// key on the card, then set CRE/agent recipient via LEDGER_PGP_RECIPIENT (the key
// id or uid). With no card/recipient the mandate is written in clear with
// sealed:false, so the agent still runs for the demo — just unsealed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SEAL_FILE = join(HERE, ".mandate.gpg");
const PLAIN_FILE = join(HERE, ".mandate.json"); // fallback when no PGP recipient

const RECIPIENT = process.env.LEDGER_PGP_RECIPIENT || "";

// Is a Ledger OpenPGP card actually reachable right now?
export async function pgpCardAvailable() {
  if (!RECIPIENT) return false;
  try { await exec("gpg", ["--card-status"], { timeout: 8000 }); return true; }
  catch { return false; }
}

// Encrypt the mandate to the Ledger OpenPGP key. Returns { sealed, recipient }.
export async function sealMandate(mandate) {
  const json = JSON.stringify(mandate, null, 2);
  if (!RECIPIENT) { writeFileSync(PLAIN_FILE, json); return { sealed: false, reason: "no LEDGER_PGP_RECIPIENT" }; }
  const tmp = join(HERE, `.mandate-${process.pid}.json`);
  writeFileSync(tmp, json);
  try {
    await exec("gpg", ["--batch", "--yes", "--trust-model", "always",
      "-r", RECIPIENT, "--output", SEAL_FILE, "--encrypt", tmp], { timeout: 20000 });
    if (existsSync(PLAIN_FILE)) rmSync(PLAIN_FILE, { force: true });
    return { sealed: true, recipient: RECIPIENT };
  } catch (e) {
    // device/app not ready — keep the demo alive, unsealed.
    writeFileSync(PLAIN_FILE, json);
    return { sealed: false, reason: String(e.message || e).split("\n")[0] };
  } finally { rmSync(tmp, { force: true }); }
}

// Open the mandate. If sealed, this prompts on the Ledger (PIN + confirm) and
// only succeeds with the device present. Returns the parsed mandate.
export async function unsealMandate() {
  if (existsSync(SEAL_FILE)) {
    const { stdout } = await exec("gpg", ["--batch", "--yes", "--decrypt", SEAL_FILE],
      { encoding: "utf8", maxBuffer: 1 << 20, timeout: 60000 });
    return JSON.parse(stdout);
  }
  if (existsSync(PLAIN_FILE)) return JSON.parse(readFileSync(PLAIN_FILE, "utf8"));
  throw new Error("no mandate sealed");
}

export function mandateSealed() { return existsSync(SEAL_FILE); }
