import { useEffect, useState } from "react";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { api } from "./lib/api";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia

type Status = { hasSeed: boolean; unlocked: boolean; enrolled: boolean };
type Proposal = { action: string; token: string; amount: string; recipientAddress: string; rationale: string };

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [address, setAddress] = useState("");
  const [balances, setBalances] = useState<any[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState("");

  const say = (m: string) => setLog(l => [m, ...l].slice(0, 8));
  const refresh = () => api.status().then(setStatus);
  const wrap = (label: string, fn: () => Promise<void>) => async () => {
    setErr(""); setBusy(label);
    try { await fn(); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(""); }
  };
  useEffect(() => { refresh(); }, []);

  const loadBalance = async () => {
    const d = await api.balance();
    setBalances((d.balances?.balances || d.balances || []) as any[]);
  };

  const create = wrap("create", async () => { await api.create(); say("Seed generated and encrypted to your Ledger (OpenPGP)."); await refresh(); });
  const unlock = wrap("unlock", async () => {
    say("Asking your Ledger to decrypt the seed… confirm on the device.");
    const d = await api.unlock(); setAddress(d.address); say("Unlocked by your Ledger. The seed lives in memory only."); await refresh(); await loadBalance();
  });
  const lock = wrap("lock", async () => { await api.lock(); setAddress(""); setBalances([]); setProposal(null); say("Locked. Only ciphertext remains at rest."); await refresh(); });
  const fund = wrap("fund", async () => { say("Depositing 1 USDC into your private account…"); await api.deposit(USDC, "1000000"); say("Deposited. Indexing private balance…"); setTimeout(loadBalance, 4000); });

  const enroll = wrap("enroll", async () => {
    const { options } = await api.fido2RegOptions();
    const resp = await startRegistration({ optionsJSON: options });
    await api.fido2RegVerify(resp); say("Ledger Security Key enrolled (FIDO2)."); await refresh();
  });

  const askCopilot = wrap("copilot", async () => {
    const d = await api.propose(recipient || address);
    setProposal(d.proposal); say(d.proposal ? "Co-pilot proposed a private transfer." : "Co-pilot: no funded balance to move yet.");
  });

  const approveAndSend = wrap("transfer", async () => {
    if (!proposal) return;
    say("Tap your Ledger to approve…");
    const { options } = await api.fido2AuthOptions();
    const assertion = await startAuthentication({ optionsJSON: options });
    const to = recipient || proposal.recipientAddress;
    await api.transfer(assertion, to, proposal.amount, proposal.token);
    say("Approved by tap → private transfer executed."); setProposal(null); setTimeout(loadBalance, 1500);
  });

  return (
    <div className="wrap">
      <header>
        <h1>Unlink</h1>
        <p className="sub">Your private keys live in your Ledger.</p>
      </header>

      <div className="badges">
        <span className={status?.hasSeed ? "on" : ""}>OpenPGP custody</span>
        <span className={status?.enrolled ? "on" : ""}>Security Key (FIDO2)</span>
        <span className={status?.unlocked ? "on" : ""}>{status?.unlocked ? "unlocked" : "locked"}</span>
      </div>

      <section className="card">
        <h2>1 · Custody — Ledger OpenPGP</h2>
        <p className="muted">The Unlink seed is encrypted to your Ledger. It exists only as ciphertext; only your device decrypts it.</p>
        <div className="row">
          {!status?.hasSeed && <button onClick={create} disabled={!!busy}>Generate &amp; encrypt seed</button>}
          {status?.hasSeed && !status?.unlocked && <button onClick={unlock} disabled={!!busy}>Unlock (decrypt on Ledger)</button>}
          {status?.unlocked && <button className="ghost" onClick={lock} disabled={!!busy}>Lock</button>}
        </div>
        {address && <code className="addr">{address}</code>}
      </section>

      <section className="card" data-off={!status?.unlocked}>
        <h2>2 · Private balance</h2>
        <div className="row"><button className="ghost" onClick={wrap("balance", loadBalance)} disabled={!status?.unlocked || !!busy}>Refresh</button>
          <button className="ghost" onClick={fund} disabled={!status?.unlocked || !!busy}>Deposit 1 USDC (private)</button></div>
        {balances.length === 0 ? <p className="muted">No private balance yet.</p> :
          <ul className="bal">{balances.map((b, i) => <li key={i}><b>{b.symbol || b.token}</b><span>{b.amount}</span></li>)}</ul>}
      </section>

      <section className="card" data-off={!status?.unlocked}>
        <h2>3 · Security Key — FIDO2</h2>
        <p className="muted">Nothing moves without a physical tap on the Ledger Security Key app.</p>
        <button onClick={enroll} disabled={!status?.unlocked || !!busy}>{status?.enrolled ? "Re-enroll Security Key" : "Enroll Security Key (tap)"}</button>
      </section>

      <section className="card" data-off={!status?.unlocked}>
        <h2>4 · AI co-pilot</h2>
        <p className="muted">The co-pilot proposes private actions. It can sign nothing — only your seed + tap can.</p>
        <input placeholder="recipient unlink1… (optional)" value={recipient} onChange={e => setRecipient(e.target.value)} />
        <div className="row"><button onClick={askCopilot} disabled={!status?.unlocked || !!busy}>Ask the co-pilot</button></div>
        {proposal && (
          <div className="proposal">
            <p>{proposal.rationale}</p>
            <div className="pmeta"><span>{proposal.amount}</span> <span>{proposal.token.slice(0, 10)}…</span></div>
            <button className="primary" onClick={approveAndSend} disabled={!status?.enrolled || !!busy}>
              {status?.enrolled ? "Tap Ledger to approve & send privately" : "Enroll Security Key first"}
            </button>
          </div>
        )}
      </section>

      {err && <div className="err">{err}</div>}
      <ul className="log">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
      <footer>OpenPGP custodies the key · Security Key authorizes the action · Unlink keeps it private</footer>
    </div>
  );
}
