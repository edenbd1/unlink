// Yield strategy co-pilot. You describe your goals; it proposes a concrete
// strategy (which vault, how much, a rebalancing rule). It can sign nothing and
// move nothing. The only thing that deploys funds is your Ledger approval.
//
// Uses an LLM when an API key is set (Mistral, or Anthropic as a fallback),
// otherwise a deterministic rule, so the flow works with or without a key.

function parseJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/); // extract the JSON object
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

async function askMistral(system, user) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) return null;
  try {
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
    return parseJson(d?.choices?.[0]?.message?.content);
  } catch { return null; }
}

async function askAnthropic(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6", max_tokens: 1024, system, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json();
    return parseJson(d?.content?.[0]?.text);
  } catch { return null; }
}

// Returns { json, model } from whichever LLM is configured, or null.
async function askLLM(system, user) {
  if (process.env.MISTRAL_API_KEY) {
    const j = await askMistral(system, user);
    if (j) return { json: j, model: "mistral" };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const j = await askAnthropic(system, user);
    if (j) return { json: j, model: "claude" };
  }
  return null;
}

const fmt = (base) => "$" + (Number(base) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Normalize an allocation list: map each entry to a known vault, keep positive
// integer percentages, and fix rounding so they sum to exactly 100.
function normalizeAllocations(allocs, vaults) {
  const byName = (n) => vaults.find((v) => v.name.toLowerCase() === String(n || "").toLowerCase());
  const byAddr = (a) => vaults.find((v) => v.address.toLowerCase() === String(a || "").toLowerCase());
  const out = (allocs || [])
    .map((a) => {
      const v = byAddr(a.vault) || byName(a.vaultName) || byName(a.name);
      return v ? { vault: v.address, vaultName: v.name, apy: v.apy, risk: v.risk, pct: Math.max(0, Math.round(Number(a.pct) || 0)) } : null;
    })
    .filter((a) => a && a.pct > 0);
  if (!out.length) return null;
  out[0].pct += 100 - out.reduce((s, a) => s + a.pct, 0);
  return out;
}

const blended = (allocs) => Math.round(allocs.reduce((s, a) => s + (a.pct / 100) * a.apy, 0) * 10) / 10;

// vaults: [{ address, name, apy, risk }]  amountBase: USDC base units (6 decimals)
export async function proposeStrategy({ goals, amountBase, vaults }) {
  const sorted = [...vaults].sort((a, b) => b.apy - a.apy);

  const system =
    "You are an autonomous DeFi yield strategist managing a user's PRIVATE USDC " +
    "balance (held in the Unlink privacy pool). You allocate across ERC-4626 vaults " +
    "via an Execution Account, and an automated agent later rebalances within the " +
    "mandate the user approves on a Ledger hardware wallet. You only PROPOSE; only " +
    "the Ledger moves funds.\n" +
    "Design a real PORTFOLIO: diversify the capital across two or more vaults (do " +
    "not put everything in one vault unless the goals truly demand it). Match the " +
    "risk to the user's words.\n" +
    "Reply ONLY with JSON: { summary (one line), riskLevel ('low'|'medium'|'high'), " +
    "allocations: [{ vaultName, pct (integer) }] (pct sum to 100), rebalance: " +
    "{ frequency, trigger, rule } (short strings), rationale (2-3 sentences on the " +
    "split and the plan) }.";
  const user =
    `Goals: ${goals || "safe, steady yield on my USDC"}\n` +
    `Capital to deploy: ${fmt(amountBase)}\n` +
    `Vaults (ERC-4626, USDC):\n` +
    vaults.map((v) => `- ${v.name}: ~${v.apy}% APY, ${v.risk} risk`).join("\n");

  const res = await askLLM(system, user);
  const aiAllocs = res?.json && normalizeAllocations(res.json.allocations, vaults);
  if (aiAllocs) {
    const ai = res.json;
    return {
      source: res.model,
      summary: ai.summary || "AI yield strategy",
      riskLevel: ai.riskLevel || "medium",
      amountBase,
      allocations: aiAllocs,
      blendedApy: blended(aiAllocs),
      rebalance: {
        frequency: ai.rebalance?.frequency || "weekly",
        trigger: ai.rebalance?.trigger || "an APY gap above 1.5% between vaults",
        rule: ai.rebalance?.rule || "shift toward the best risk-adjusted APY, capped per vault",
      },
      rationale: ai.rationale || "",
    };
  }

  // Deterministic fallback: a real diversified split by risk appetite.
  const low = vaults.find((v) => v.risk === "low") || sorted[sorted.length - 1];
  const high = vaults.find((v) => v.risk === "high") || sorted[0];
  let split, level, label;
  if (/aggress|max|degen|risk\s*on|high\s*risk/i.test(goals || "")) { split = [25, 75]; level = "high"; label = "Growth-tilted"; }
  else if (/safe|low|conserv|preserv|stable|capital/i.test(goals || "")) { split = [75, 25]; level = "low"; label = "Capital-preserving"; }
  else { split = [50, 50]; level = "medium"; label = "Balanced"; }
  const allocations = normalizeAllocations(
    [{ vaultName: low.name, pct: split[0] }, { vaultName: high.name, pct: split[1] }], vaults);
  const bApy = blended(allocations);
  return {
    source: "rule",
    summary: `${label} USDC yield, ~${bApy}% blended APY`,
    riskLevel: level,
    amountBase,
    allocations,
    blendedApy: bApy,
    rebalance: {
      frequency: "weekly",
      trigger: "an APY gap above 1.5% between the vaults, sustained 24h",
      rule: `shift toward the higher risk-adjusted APY, capped at ${level === "high" ? 80 : 60}% per vault`,
    },
    rationale:
      `Diversify ${fmt(amountBase)} as ${split[0]}% ${low.name} and ${split[1]}% ${high.name} for a ~${bApy}% blended APY at ${level} risk. ` +
      `Your Ledger approves this mandate once; the agent then rebalances weekly within it, so you never tap for routine moves.`,
  };
}
