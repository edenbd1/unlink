// Local stand-in for the Chainlink Confidential AI Attester.
//
// Exposes the SAME HTTP contract as the real sandbox
// (https://confidential-ai-dev-preview.cldev.cloud): POST /v1/inference + GET
// /v1/inference/{id}, the same request body (model, system_prompt, prompt,
// resources, cre_callback) and the same response shape (id, status, output as a
// ```json fence, resources[].request_digest / response_digest). So the WHOLE
// pipeline runs locally end-to-end with no API key: the host client polls it, and
// the CRE workflow's HTTP trigger receives its callback — identical code paths.
//
// HONEST LABELLING: this is NOT a TEE. The inference runs on Mistral (or a
// deterministic fallback) on this host, and the digests are real SHA-256 over our
// own canonicalisation. Point CONFIDENTIAL_AI_BASE_URL at the real sandbox + set
// a real key to get the genuine TEE attestation; the request/response are the same.
import { createHash, randomUUID } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(typeof s === "string" ? s : JSON.stringify(s)).digest("hex");
const jobs = new Map(); // id -> status response object

// Ask Mistral with an arbitrary system+user prompt; return the raw text.
async function askMistral(system, user) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) return null;
  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.MISTRAL_MODEL || "mistral-large-latest",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: 1024,
      response_format: { type: "json_object" },
    }),
  });
  const d = await r.json();
  return d?.choices?.[0]?.message?.content || null;
}

// Deterministic fallback if Mistral is unavailable: pull the vault addresses out
// of the prompt and split by the risk words, so the attester still answers offline.
function fallbackAllocation(prompt) {
  const addrs = [...String(prompt).matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0]);
  const stable = addrs[0] || "0xedf18f946344395d9fc5e20a67289ccce3f25b6f";
  const growth = addrs[1] || "0xe7c683e76b3a99d32cbda67beb33eedacaf6f90f";
  // Look at the goals, not the vault names ("Stable"/"Growth") which always appear.
  const notAggr = /not\s+(too\s+)?aggress/i.test(prompt);
  const aggressive = !notAggr && /aggress|degen|max(imal)?\s*(yield|apy|growth)|high\s*risk/i.test(prompt);
  const safe = notAggr || /safe|conserv|preserv|steady|capital\s*preserv|low\s*risk/i.test(prompt);
  const [sBps, gBps] = aggressive ? [3000, 7000] : safe ? [6000, 4000] : [5000, 5000];
  const blended = Math.round(((sBps / 10000) * 4.1 + (gBps / 10000) * 7.4) * 100);
  return {
    approved: true,
    risk_level: aggressive ? "high" : safe ? "medium" : "medium",
    blended_apy_bps: blended,
    reason: `Local stand-in: ${sBps / 100}% Aave / ${gBps / 100}% Morpho for a ~${(blended / 100).toFixed(2)}% blended APY.`,
    allocations: [
      { vault: stable, name: "Aave USDC", bps: sBps },
      { vault: growth, name: "Morpho USDC", bps: gBps },
    ],
  };
}

// Find a vault's "~X%" APY in the prompt so we can recompute the blended APY
// from the weights (LLMs are unreliable at expressing basis points).
function apyForVault(prompt, addr) {
  const esc = String(addr).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = String(prompt).match(new RegExp(esc + "[^~]*~\\s*([0-9.]+)\\s*%", "i"));
  return m ? Number(m[1]) : null;
}

// Recompute blended_apy_bps = Σ (bps/10000 · vaultApy) · 100, when the vault APYs
// are present in the prompt. Keeps the on-chain attested number honest.
function fixBlended(decision, prompt) {
  const allocs = decision.allocations || [];
  let acc = 0;
  for (const a of allocs) {
    const apy = apyForVault(prompt, a.vault);
    if (apy == null) return decision; // can't recompute reliably — leave as-is
    acc += (Number(a.bps) / 10000) * apy;
  }
  decision.blended_apy_bps = Math.round(acc * 100);
  return decision;
}

// Run one inference and fill in the job's terminal status.
async function runJob(id, body) {
  const job = jobs.get(id);
  try {
    job.status = "processing";
    let jsonText = null;
    try { jsonText = await askMistral(body.system_prompt || "", body.prompt || ""); } catch { /* fall back */ }
    if (!jsonText) jsonText = JSON.stringify(fallbackAllocation(body.prompt || ""));
    // Normalize the blended APY from the weights (don't trust the LLM's bps).
    try { jsonText = JSON.stringify(fixBlended(JSON.parse(jsonText), body.prompt || "")); } catch { /* keep raw */ }

    // Faithful to the real attester: the answer is a ```json-fenced string.
    const output = "```json\n" + jsonText.trim() + "\n```";
    const requestDigest = sha256({ model: body.model, system_prompt: body.system_prompt, prompt: body.prompt });
    const responseDigest = sha256(output);
    const contentDigest = sha256(body.prompt || "");

    Object.assign(job, {
      status: "completed",
      output,
      resources: [{
        url: "inline://profile.json",
        digest: contentDigest,
        request_digest: requestDigest,
        response_digest: responseDigest,
        content_type: "application/json",
        preprocessed: true,
      }],
      usage: { prompt_tokens: (body.prompt || "").length, completion_tokens: jsonText.length },
      completed_at: new Date().toISOString(),
    });
  } catch (e) {
    Object.assign(job, { status: "failed", error: String(e.message || e) });
  }

  // If a CRE callback URL was given, POST the terminal status response to it
  // (the workflow's HTTP trigger reads it as payload.input) — same as the real attester.
  const cb = body.cre_callback?.url;
  if (cb) {
    try {
      await fetch(cb, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(jobs.get(id)) });
    } catch { /* best-effort, demo */ }
  }
}

// Core: accept an inference request, return the 202 snapshot, kick off processing.
export function submitLocalInference(body) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const snapshot = {
    id, status: "queued", model: body.model || "gemma4",
    system_prompt: body.system_prompt || "", prompt: body.prompt || "",
    created_at: now, started_at: now,
  };
  jobs.set(id, snapshot);
  runJob(id, body); // async, don't await
  return snapshot;
}

export function getLocalInference(id) { return jobs.get(id) || null; }

// Mount the attester routes onto an existing Hono app (so it shares the web port).
export function mountLocalAttester(app) {
  app.post("/v1/inference", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(submitLocalInference(body), 202);
  });
  app.get("/v1/inference/:id", (c) => {
    const job = getLocalInference(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    return c.json(job);
  });
  return app;
}
