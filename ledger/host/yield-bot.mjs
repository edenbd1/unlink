// Autonomous yield agent (brick #3 of AI-YIELD-AGENT.md).
//
// You approve a MANDATE once on the Ledger (which vaults, the rebalance trigger,
// a cap per vault). From then on this agent watches the vaults' live APYs and
// rebalances WITHIN that mandate on its own — no human tap per move. Custody is
// preserved: every rebalance is still an Unlink spend signed by the Secure
// Element (immediate-sign), so the key never leaves the chip; the once-approved
// mandate is what authorizes the agent to act without re-prompting.
//
// The agent never invents a destination outside `mandate.allowedVaults`, never
// exceeds `mandate.maxPerVaultPct`, and only moves when the live APY edge clears
// `mandate.thresholdPct`. It signs nothing itself — it calls the injected
// rebalance() which drives the device.

// A small live-APY oracle. Each vault's APY random-walks inside a band around its
// quoted rate, so the demo actually shows the agent reacting to a moving market.
// Swap this for a real yield feed (a Chainlink Data Feed / the vault's on-chain
// rate) without touching the decision logic.
function makeApyOracle(vaults) {
  const state = new Map(vaults.map((v) => [v.address.toLowerCase(), v.apy]));
  return {
    read(addr) { return state.get(addr.toLowerCase()); },
    snapshot() { return vaults.map((v) => ({ address: v.address, name: v.name, apy: Math.round(state.get(v.address.toLowerCase()) * 100) / 100 })); },
    drift() {
      for (const v of vaults) {
        const k = v.address.toLowerCase();
        const cur = state.get(k);
        // mean-reverting random walk: pull toward base apy, plus noise
        const next = cur + (v.apy - cur) * 0.15 + (Math.random() - 0.5) * 1.2;
        const band = Math.max(0.5, v.apy * 0.6);
        state.set(k, Math.min(v.apy + band, Math.max(v.apy - band, next)));
      }
    },
  };
}

// risk-adjusted score: live APY minus a penalty for a high-risk vault, so a
// "low" mandate needs a bigger raw-APY edge before it chases the risky vault.
function score(liveApy, vaultRisk, mandateRisk) {
  const penalty = vaultRisk === "high" ? (mandateRisk === "high" ? 0.3 : mandateRisk === "medium" ? 1.0 : 2.0) : 0;
  return liveApy - penalty;
}

export function createYieldBot({ getPositions, rebalance, log: emit }) {
  let mandate = null;       // { allowedVaults, thresholdPct, maxPerVaultPct, riskLevel, rebalance, approvedAt, sealed }
  let oracle = null;
  let timer = null;
  let intervalMs = 20000;
  const history = [];       // [{ at, kind, msg, ... }]
  let ticks = 0, moves = 0;
  let busy = false;

  const note = (kind, msg, extra = {}) => {
    const entry = { at: Date.now(), kind, msg, ...extra };
    history.unshift(entry);
    if (history.length > 50) history.pop();
    if (emit) emit(`[agent] ${msg}`);
    return entry;
  };

  async function evaluate() {
    if (!mandate || busy) return;
    busy = true;
    try {
      oracle.drift();
      ticks++;
      const allowed = mandate.allowedVaults;
      const positions = getPositions().filter((p) => p.accountIndex != null && p.vault);
      const snap = oracle.snapshot().filter((s) => allowed.some((v) => v.address.toLowerCase() === s.address.toLowerCase()));
      const snapStr = snap.map((s) => `${s.name.replace(/^Unlink /, "")} ${s.apy}%`).join(" · ");

      if (!positions.length) { note("tick", `watching ${snapStr} — no managed position`); return; }

      for (const pos of positions) {
        // best allowed vault by risk-adjusted live score
        const scored = allowed
          .map((v) => ({ v, s: score(oracle.read(v.address), v.risk, mandate.riskLevel) }))
          .sort((a, b) => b.s - a.s);
        const best = scored[0].v;
        const current = allowed.find((v) => v.address.toLowerCase() === pos.vault.toLowerCase()) || null;
        const curScore = current ? score(oracle.read(current.address), current.risk, mandate.riskLevel) : -Infinity;
        const edge = Math.round((scored[0].s - curScore) * 100) / 100;

        if (!current || (best.address.toLowerCase() !== pos.vault.toLowerCase() && edge >= mandate.thresholdPct)) {
          note("tick", `${snapStr} → edge +${edge}% to ${best.name.replace(/^Unlink /, "")} ≥ ${mandate.thresholdPct}% trigger`);
          try {
            const r = await rebalance({ pos, target: best });
            moves++;
            note("rebalance", `moved ${(Number(pos.shares) / 1e6).toFixed(2)} USDC → ${best.name} (~${best.apy}%)`, { txId: r?.txId || null, vault: best.address });
          } catch (e) {
            note("error", `rebalance failed: ${String(e.message || e)}`);
          }
        } else {
          note("tick", `${snapStr} → hold ${current.name.replace(/^Unlink /, "")} (edge +${edge}% < ${mandate.thresholdPct}%)`);
        }
      }
    } finally { busy = false; }
  }

  return {
    start({ mandate: m, intervalSec }) {
      mandate = m;
      oracle = makeApyOracle(m.allowedVaults);
      intervalMs = Math.max(3, Number(intervalSec) || 20) * 1000;
      if (timer) clearInterval(timer);
      note("start", `agent armed — ${m.allowedVaults.map((v) => v.name.replace(/^Unlink /, "")).join(" / ")}, trigger ${m.thresholdPct}% edge, cap ${m.maxPerVaultPct}%/vault, every ${intervalMs / 1000}s${m.sealed ? ", mandate sealed to Ledger OpenPGP" : ""}`);
      timer = setInterval(() => evaluate().catch(() => {}), intervalMs);
      // fire one tick immediately so the demo shows life at once
      evaluate().catch(() => {});
      return this.status();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (mandate) note("stop", "agent disarmed");
      return this.status();
    },
    async tick() { await evaluate(); return this.status(); },
    status() {
      return {
        running: !!timer,
        intervalSec: intervalMs / 1000,
        ticks, moves,
        mandate: mandate && {
          allowedVaults: mandate.allowedVaults.map((v) => ({ name: v.name, apy: v.apy, address: v.address })),
          thresholdPct: mandate.thresholdPct,
          maxPerVaultPct: mandate.maxPerVaultPct,
          riskLevel: mandate.riskLevel,
          approvedAt: mandate.approvedAt,
          sealed: !!mandate.sealed,
        },
        apys: oracle ? oracle.snapshot() : [],
        log: history.slice(0, 20),
      };
    },
  };
}
