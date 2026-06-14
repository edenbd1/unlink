// Autonomous yield agent (brick #3 of AI-YIELD-AGENT.md).
//
// You approve a MANDATE once on the Ledger: the target allocation (e.g. 30% Aave,
// 30% Spark, 25% Moonwell, 15% Fluid), a tilt band, and a per-vault cap. From then
// on this agent MAINTAINS that allocation on its own — it doesn't chase the single
// best vault and consolidate; it keeps every vault near its target weight, tilting
// only within the approved band toward the best risk-adjusted APY, never past the
// cap. Custody holds: every rebalance is an Unlink spend signed by the Secure
// Element (immediate-sign), so the key never leaves the chip; the once-approved
// mandate is what lets the agent act without re-prompting.
//
// It signs nothing itself — it calls the injected rebalancePortfolio() which
// drives the device to move the EA's shares to the new target weights.

// A small live-APY oracle. Each vault's APY random-walks inside a band around its
// quoted rate, so the demo shows the agent reacting to a moving market. Swap for a
// real yield feed (a Chainlink Data Feed / the vault's on-chain rate) without
// touching the decision logic.
function makeApyOracle(vaults) {
  const state = new Map(vaults.map((v) => [v.vault.toLowerCase(), v.apy]));
  return {
    read(addr) { return state.get(addr.toLowerCase()); },
    snapshot() { return vaults.map((v) => ({ address: v.vault, name: v.vaultName, apy: Math.round(state.get(v.vault.toLowerCase()) * 100) / 100 })); },
    drift() {
      for (const v of vaults) {
        const k = v.vault.toLowerCase();
        const cur = state.get(k);
        const next = cur + (v.apy - cur) * 0.15 + (Math.random() - 0.5) * 1.2;
        const band = Math.max(0.5, v.apy * 0.6);
        state.set(k, Math.min(v.apy + band, Math.max(v.apy - band, next)));
      }
    },
  };
}

// risk-adjusted score: live APY minus a penalty for riskier vaults, so a "low"
// mandate needs a bigger raw-APY edge before it tilts toward a risky vault.
function score(liveApy, vaultRisk, mandateRisk) {
  const p = { low: 0, medium: 0.6, high: 1.4 }[vaultRisk] ?? 0;
  const m = { low: 1.6, medium: 1.0, high: 0.5 }[mandateRisk] ?? 1.0;
  return liveApy - p * m;
}

const short = (n) => String(n).replace(/ USDC$/, ""); // "Aave USDC" -> "Aave"

export function createYieldBot({ getPositions, rebalancePortfolio, log: emit }) {
  let mandate = null; // { targets:[{vault,vaultName,apy,risk,targetBps}], bandBps, maxPerVaultBps, rebalanceTolBps, thresholdPct, riskLevel, sealed, approvedAt }
  let oracle = null, timer = null, intervalMs = 20000;
  const history = [];
  let ticks = 0, moves = 0, busy = false;

  const note = (kind, msg, extra = {}) => {
    const e = { at: Date.now(), kind, msg, ...extra };
    history.unshift(e); if (history.length > 50) history.pop();
    if (emit) emit(`[agent] ${msg}`);
    return e;
  };

  async function evaluate() {
    if (!mandate || busy) return;
    busy = true;
    try {
      oracle.drift(); ticks++;
      const T = mandate.targets;
      const positions = getPositions().filter((p) => p.accountIndex != null && p.vault);
      const apyStr = T.map((t) => `${short(t.vaultName)} ${oracle.read(t.vault).toFixed(1)}%`).join(" · ");
      if (!positions.length) { note("tick", `watching ${apyStr} — no managed position`); return; }

      const accountIndex = positions[0].accountIndex;
      const ps = positions.filter((p) => p.accountIndex === accountIndex);
      // current shares + weights per target vault
      const cur = {}; let total = 0;
      for (const t of T) { const p = ps.find((x) => x.vault.toLowerCase() === t.vault.toLowerCase()); const sh = p ? Number(p.shares) : 0; cur[t.vault] = sh; total += sh; }
      if (total <= 0) { note("tick", `${apyStr} — positions empty`); return; }
      const curBps = {}; T.forEach((t) => (curBps[t.vault] = Math.round((cur[t.vault] / total) * 10000)));

      // desired weights = targets, tilted within the band toward the best
      // risk-adjusted vault when its edge over the worst clears the threshold.
      const scored = T.map((t) => ({ t, s: score(oracle.read(t.vault), t.risk, mandate.riskLevel) })).sort((a, b) => b.s - a.s);
      const best = scored[0].t, worst = scored[scored.length - 1].t;
      const edge = Math.round((scored[0].s - scored[scored.length - 1].s) * 100) / 100;
      const desired = {}; T.forEach((t) => (desired[t.vault] = t.targetBps));
      let tilt = 0;
      if (T.length >= 2 && best.vault !== worst.vault && edge >= mandate.thresholdPct) {
        tilt = Math.min(mandate.bandBps, mandate.maxPerVaultBps - best.targetBps, worst.targetBps);
        if (tilt > 0) { desired[best.vault] += tilt; desired[worst.vault] -= tilt; }
      }

      const maxDrift = Math.max(...T.map((t) => Math.abs(desired[t.vault] - curBps[t.vault])));
      if (maxDrift < mandate.rebalanceTolBps) { note("tick", `${apyStr} → on target (drift ${maxDrift}bps < ${mandate.rebalanceTolBps})`); return; }

      // target shares (last vault absorbs rounding so the total is conserved)
      let acc = 0;
      const targetShares = T.map((t, i) => {
        const sh = i === T.length - 1 ? total - acc : Math.round(total * (desired[t.vault] / 10000));
        if (i < T.length - 1) acc += sh;
        return { vault: t.vault, vaultName: t.vaultName, shares: String(sh) };
      });

      const desc = T.map((t) => `${Math.round(desired[t.vault] / 100)}% ${short(t.vaultName)}`).join(" / ");
      note("tick", `${apyStr} → tilt ${tilt}bps toward ${short(best.vaultName)} (edge +${edge}% ≥ ${mandate.thresholdPct}%)`);
      try {
        const r = await rebalancePortfolio({ accountIndex, targetShares });
        moves++;
        note("rebalance", `rebalanced to ${desc}`, { txId: r?.txId || null });
      } catch (e) { note("error", `rebalance failed: ${String(e.message || e)}`); }
    } finally { busy = false; }
  }

  return {
    start({ mandate: m, intervalSec }) {
      mandate = m;
      oracle = makeApyOracle(m.targets);
      intervalMs = Math.max(3, Number(intervalSec) || 20) * 1000;
      if (timer) clearInterval(timer);
      const tgt = m.targets.map((t) => `${Math.round(t.targetBps / 100)}% ${short(t.vaultName)}`).join(" / ");
      note("start", `agent armed — holding ${tgt}, tilt ±${m.bandBps / 100}% within cap ${m.maxPerVaultBps / 100}%, every ${intervalMs / 1000}s${m.sealed ? ", mandate sealed to Ledger OpenPGP" : ""}`);
      timer = setInterval(() => evaluate().catch(() => {}), intervalMs);
      evaluate().catch(() => {});
      return this.status();
    },
    stop() { if (timer) clearInterval(timer); timer = null; if (mandate) note("stop", "agent disarmed"); return this.status(); },
    async tick() { await evaluate(); return this.status(); },
    status() {
      return {
        running: !!timer, intervalSec: intervalMs / 1000, ticks, moves,
        mandate: mandate && {
          targets: mandate.targets.map((t) => ({ name: t.vaultName, apy: t.apy, address: t.vault, targetPct: t.targetBps / 100 })),
          allowedVaults: mandate.targets.map((t) => ({ name: t.vaultName, apy: t.apy, address: t.vault })),
          bandPct: mandate.bandBps / 100, maxPerVaultPct: mandate.maxPerVaultBps / 100,
          riskLevel: mandate.riskLevel, approvedAt: mandate.approvedAt, sealed: !!mandate.sealed, unsealed: !!mandate.unsealed,
        },
        apys: oracle ? oracle.snapshot() : [],
        log: history.slice(0, 20),
      };
    },
  };
}
