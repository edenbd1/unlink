// Seal documents (a strategy, a mandate) to the Ledger OpenPGP key.
//
// Encrypted to the device's OpenPGP key, a doc only ever exists as ciphertext and
// can only be opened with the physical Ledger present (gpg --decrypt -> scdaemon
// -> Ledger, PIN on device). So validating a strategy means OPENING it on your
// Ledger: you can't deploy a strategy the device hasn't decrypted. The rules are
// under hardware custody. Same primitive the earlier webapp used to custody the
// Unlink seed (webapp/companion/gpg-custody.ts).
//
// Setup (one time): install the OpenPGP app on the Ledger, generate/import a PGP
// key on the card, then set LEDGER_PGP_RECIPIENT (key id or uid). With no
// recipient, docs are written in clear (sealed:false) so the demo still runs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const RECIPIENT = process.env.LEDGER_PGP_RECIPIENT || "";

const paths = (name) => ({ gpg: join(HERE, `.${name}.gpg`), plain: join(HERE, `.${name}.json`) });

// Is a Ledger OpenPGP card actually reachable right now?
export async function pgpCardAvailable() {
  if (!RECIPIENT) return false;
  try { await exec("gpg", ["--card-status"], { timeout: 8000 }); return true; }
  catch { return false; }
}

// Encrypt a doc to the Ledger OpenPGP key. Returns { sealed, recipient }.
export async function sealDoc(name, doc) {
  const json = JSON.stringify(doc, null, 2);
  const { gpg, plain } = paths(name);
  if (!RECIPIENT) { writeFileSync(plain, json); return { sealed: false, reason: "no LEDGER_PGP_RECIPIENT" }; }
  const tmp = join(HERE, `.${name}-${process.pid}.json`);
  writeFileSync(tmp, json);
  try {
    await exec("gpg", ["--batch", "--yes", "--trust-model", "always",
      "-r", RECIPIENT, "--output", gpg, "--encrypt", tmp], { timeout: 20000 });
    if (existsSync(plain)) rmSync(plain, { force: true });
    return { sealed: true, recipient: RECIPIENT };
  } catch (e) {
    writeFileSync(plain, json); // keep the demo alive, unsealed
    return { sealed: false, reason: String(e.message || e).split("\n")[0] };
  } finally { rmSync(tmp, { force: true }); }
}

// Open a doc. If sealed, this prompts on the Ledger (PIN) and only succeeds with
// the device present. Returns the parsed object.
export async function unsealDoc(name) {
  const { gpg, plain } = paths(name);
  if (existsSync(gpg)) {
    const { stdout } = await exec("gpg", ["--batch", "--yes", "--decrypt", gpg],
      { encoding: "utf8", maxBuffer: 1 << 20, timeout: 60000 });
    return JSON.parse(stdout);
  }
  if (existsSync(plain)) return JSON.parse(readFileSync(plain, "utf8"));
  throw new Error(`no ${name} sealed`);
}

export function docSealed(name) { return existsSync(paths(name).gpg); }

// Named wrappers.
export const sealStrategy = (s) => sealDoc("strategy", s);
export const unsealStrategy = () => unsealDoc("strategy");
export const strategySealed = () => docSealed("strategy");
export const sealMandate = (m) => sealDoc("mandate", m);
export const unsealMandate = () => unsealDoc("mandate");
export const mandateSealed = () => docSealed("mandate");
