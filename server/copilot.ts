// AI co-pilot. It only ever *proposes* a private action — it can sign nothing and
// move nothing without the OpenPGP-custodied seed and a physical FIDO2 tap.
// If ANTHROPIC_API_KEY is set it asks Claude; otherwise a deterministic rule.
type Balance = { token: string; symbol?: string; amount: string };
export type Proposal = { action: "transfer"; token: string; amount: string; recipientAddress: string; rationale: string };

export async function propose(balances: Balance[], recipientAddress: string): Promise<Proposal | null> {
  const top = balances.filter(b => BigInt(b.amount || "0") > 0n).sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))[0];
  if (!top) return null;
  const amount = (BigInt(top.amount) / 10n).toString(); // suggest moving 10% privately
  const rationale = `You hold a private balance of ${top.symbol || top.token}. I suggest moving 10% to your savings address — privately, so the amount and destination stay unlinkable. Nothing executes until you tap your Ledger.`;
  return { action: "transfer", token: top.token, amount, recipientAddress, rationale };
}
