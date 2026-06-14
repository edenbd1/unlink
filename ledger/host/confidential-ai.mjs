// Chainlink Confidential AI Attester — host client.
//
// Submits the user's PRIVATE financial profile (yield goals, capital, Unlink-pool
// balance) to the Confidential AI inference API, which runs the allocation LLM
// INSIDE A TEE (AWS Nitro enclave) so the raw profile never leaves the enclave.
// The response carries SHA-256 provenance digests (request_digest /
// response_digest) — the response_digest becomes the on-chain transcriptHash that
// the CRE workflow signs into a DON-attested report (see ledger/cre/).
//
// Two ways to drive it:
//   • poll mode (default): submit, then poll GET /v1/inference/{id} until done.
//     Returns the allocation + digests to the host directly.
//   • callback mode: pass creCallbackUrl to have the Attester POST the result to
//     a CRE workflow HTTP-trigger (the full on-chain attestation path).
//
// Needs the API key from the Chainlink desk at ETHGlobal: CONFIDENTIAL_AI_API_KEY
// (or INFERENCE_API_KEY_VAR). With no key, runConfidentialInference returns null
// and the caller falls back to the local strategy proposer.

const REAL_URL = process.env.CONFIDENTIAL_AI_BASE_URL || "https://confidential-ai-dev-preview.cldev.cloud";
// Local stand-in attester (same /v1/inference contract), served by the web app itself.
const LOCAL_URL = process.env.LOCAL_ATTESTER_URL || `http://localhost:${process.env.WEB_PORT || 8799}`;
const MODEL = process.env.CONFIDENTIAL_AI_MODEL || "gemma4";
const realKey = () => process.env.CONFIDENTIAL_AI_API_KEY || process.env.INFERENCE_API_KEY_VAR || "";

// "real": genuine TEE sandbox (needs a key). "local": the local stand-in (default
// fallback when no key — set LOCAL_ATTESTER=0 to disable). "off": neither.
export function attesterMode() {
  if (realKey()) return "real";
  if (process.env.LOCAL_ATTESTER !== "0") return "local";
  return "off";
}
export function confidentialAiConfigured() { return attesterMode() !== "off"; }
const baseUrl = () => (attesterMode() === "real" ? REAL_URL : LOCAL_URL);

const SYSTEM =
  "You are an autonomous DeFi yield strategist analysing a user's PRIVATE financial " +
  "profile inside a TEE. Diversify the capital across the given ERC-4626 vaults and " +
  "match the risk to the user's words. You only PROPOSE an allocation; the user's " +
  "Ledger approves the mandate and an Execution Account executes within it.";

const fmtUsdc = (base) => (Number(base) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function buildPrompt({ goals, capitalBase, balanceBase, vaults }) {
  return (
    "Private profile (confidential):\n" +
    `- goals: "${goals || "safe, steady yield on my USDC"}"\n` +
    `- capital: ${fmtUsdc(capitalBase)} USDC\n` +
    `- current Unlink private balance: ${fmtUsdc(balanceBase ?? capitalBase)} USDC\n\n` +
    "Vaults (ERC-4626 USDC markets):\n" +
    vaults.map((v) => `- ${v.name}${v.protocol ? ` — ${v.protocol}` : ""} ${v.address}  ~${v.apy}% APY, ${v.risk} risk`).join("\n") +
    "\n\nRespond with ONLY a valid JSON object:\n" +
    '{ "approved": true, "risk_level": "low|medium|high", "blended_apy_bps": 582, ' +
    '"reason": "one sentence citing the split and the blended APY", ' +
    '"allocations": [ { "vault": "0x..", "name": "..", "bps": 6000 } ] }\n' +
    'The "bps" weights MUST sum to 10000 and only use the vault addresses above.'
  );
}

// Strip a ```json fence and parse.
function parseFenced(output) {
  if (!output) return null;
  const m = output.trim().match(/^```(?:[a-zA-Z0-9]+)?\s*([\s\S]*?)\s*```$/);
  try { return JSON.parse(m ? m[1].trim() : output); } catch { return null; }
}

// Map the LLM allocation to our known vaults; keep bps, normalize to sum 10000.
function normalize(decision, vaults) {
  const byAddr = (a) => vaults.find((v) => v.address.toLowerCase() === String(a || "").toLowerCase());
  const byName = (n) => vaults.find((v) => v.name.toLowerCase() === String(n || "").toLowerCase());
  let out = (decision.allocations || [])
    .map((a) => { const v = byAddr(a.vault) || byName(a.name); return v ? { vault: v.address, vaultName: v.name, apy: v.apy, risk: v.risk, bps: Math.max(0, Math.round(Number(a.bps) || 0)) } : null; })
    .filter((a) => a && a.bps > 0);
  if (!out.length) return null;
  const sum = out.reduce((s, a) => s + a.bps, 0);
  out[0].bps += 10000 - sum; // fix rounding so weights sum to 10000
  return out;
}

async function http(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (attesterMode() === "real") headers.Authorization = `Bearer ${realKey()}`;
  const r = await fetch(`${baseUrl()}${path}`, { ...opts, headers });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!r.ok) throw new Error(`Confidential AI ${r.status}: ${text.slice(0, 200)}`);
  return json;
}

// Submit one confidential inference and return its id + snapshot (202 Accepted).
export async function submitInference({ goals, capitalBase, balanceBase, vaults, creCallbackUrl }) {
  const body = {
    model: MODEL,
    system_prompt: SYSTEM,
    prompt: buildPrompt({ goals, capitalBase, balanceBase, vaults }),
    ...(creCallbackUrl ? { cre_callback: { url: creCallbackUrl } } : {}),
  };
  return http("/v1/inference", { method: "POST", body: JSON.stringify(body) });
}

export async function getInference(id) { return http(`/v1/inference/${id}`); }

// Poll until terminal (completed/failed) or timeout.
async function poll(id, { timeoutMs = 90000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await getInference(id);
    if (s.status === "completed" || s.status === "failed") return s;
    if (Date.now() > deadline) throw new Error(`inference ${id} timed out (last status: ${s.status})`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Full host flow: submit + poll + parse. Returns the attested allocation and the
// provenance digests, or null if no API key is configured.
export async function runConfidentialInference({ goals, capitalBase, balanceBase, vaults, creCallbackUrl }) {
  if (!confidentialAiConfigured()) return null;
  const submitted = await submitInference({ goals, capitalBase, balanceBase, vaults, creCallbackUrl });
  const id = submitted.id;
  const final = await poll(id);
  if (final.status !== "completed") throw new Error(`inference ${id} failed`);

  const decision = parseFenced(final.output) || {};
  const allocations = normalize(decision, vaults);
  if (!allocations) throw new Error("inference returned no usable allocation");
  const res = final.resources?.[0] || {};
  const blendedApy = Math.round(allocations.reduce((s, a) => s + (a.bps / 10000) * a.apy, 0) * 10) / 10;
  const mode = attesterMode();

  return {
    mode,                // "real" (TEE) or "local" (stand-in)
    inferenceId: id,
    model: final.model || MODEL,
    status: final.status,
    approved: decision.approved === true,
    riskLevel: decision.risk_level || "medium",
    reason: decision.reason || "",
    allocations,         // [{ vault, vaultName, apy, risk, bps }]
    blendedApy,
    // Provenance (SHA-256 digests, not signatures):
    digests: {
      content: res.digest || null,
      request: res.request_digest || null,
      response: res.response_digest || null, // -> on-chain transcriptHash
    },
    enclave: mode === "real"
      ? { provider: "AWS Nitro (TEE)", attester: "Chainlink Confidential AI", baseUrl: REAL_URL }
      : { provider: "Local stand-in (Mistral, no TEE)", attester: "Chainlink Confidential AI — local stand-in", baseUrl: LOCAL_URL },
    raw: { output: final.output },
  };
}
