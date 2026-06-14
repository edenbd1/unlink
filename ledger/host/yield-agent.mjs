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

const fmt = (base) => (Number(base) / 1e6).toFixed(2) + " USDC";

// vaults: [{ address, name, apy }]  amountBase: USDC base units (6 decimals)
export async function proposeStrategy({ goals, amountBase, vaults }) {
  const sorted = [...vaults].sort((a, b) => b.apy - a.apy);
  const best = sorted[0];

  const system =
    "You are a conservative DeFi yield strategist. The user holds a PRIVATE USDC " +
    "balance in the Unlink privacy pool and wants to put it to work in ERC-4626 " +
    "vaults via an Execution Account. You only PROPOSE; the user approves on a " +
    "Ledger hardware wallet, which is the only thing that can move funds. " +
    "Reply ONLY with a JSON object: { summary, riskLevel ('low'|'medium'|'high'), " +
    "vault (one of the given addresses), vaultName, apy (number), rebalanceRule " +
    "(short sentence), rationale (2 short sentences) }. Pick the vault that best " +
    "fits the user's goals; prefer the highest APY unless they ask for lower risk.";
  const user =
    `Goals: ${goals || "safe, steady yield on my USDC"}\n` +
    `Amount to deploy: ${fmt(amountBase)}\n` +
    `Available vaults (ERC-4626, USDC):\n` +
    vaults.map((v) => `- ${v.name} (${v.address}) ~${v.apy}% APY`).join("\n");

  const res = await askLLM(system, user);
  const ai = res?.json;
  if (ai && ai.vault) {
    return {
      source: res.model,
      summary: ai.summary || "AI yield strategy",
      riskLevel: ai.riskLevel || "low",
      vault: ai.vault,
      vaultName: ai.vaultName || best.name,
      apy: ai.apy ?? best.apy,
      amountBase,
      rebalanceRule: ai.rebalanceRule || `Move to the highest-APY vault if APY drops below ${(best.apy - 1).toFixed(1)}% for 24h`,
      rationale: ai.rationale || "",
    };
  }

  // Deterministic fallback: aggressive goals -> highest APY, else the low-risk vault.
  const wantsRisk = /aggress|high|max|degen|growth|risk/i.test(goals || "");
  const pick = wantsRisk ? best : (vaults.find((v) => v.risk === "low") || sorted[sorted.length - 1]);
  return {
    source: "rule",
    summary: wantsRisk ? "Growth USDC yield" : "Conservative USDC yield",
    riskLevel: wantsRisk ? "high" : "low",
    vault: pick.address,
    vaultName: pick.name,
    apy: pick.apy,
    amountBase,
    rebalanceRule: `Move to the highest-APY vault if the current APY drops below ${(pick.apy - 1).toFixed(1)}% for 24h`,
    rationale:
      `Deploy ${fmt(amountBase)} into ${pick.name} at ~${pick.apy}% APY, from your private balance via an Execution Account. ` +
      `Your Ledger approves the deployment; an agent then watches the APY and rebalances within this mandate.`,
  };
}
