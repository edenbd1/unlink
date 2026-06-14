const j = async (path: string, body?: any) => {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const d = await r.json();
  if (!d.ok && d.ok !== undefined && !r.ok) throw new Error(d.error || "request failed");
  if (d.ok === false) throw new Error(d.error || "request failed");
  return d;
};

export const api = {
  status: () => j("/api/custody/status"),
  create: () => j("/api/custody/create", {}),
  unlock: () => j("/api/custody/unlock", {}),
  lock: () => j("/api/custody/lock", {}),
  balance: () => j("/api/balance"),
  faucet: (token: string, amount: string) => j("/api/faucet", { token, amount }),
  deposit: (token: string, amount: string) => j("/api/deposit", { token, amount }),
  propose: (recipientAddress?: string) => j("/api/copilot/propose", { recipientAddress }),
  fido2RegOptions: () => j("/api/fido2/register/options", {}),
  fido2RegVerify: (response: any) => j("/api/fido2/register/verify", response),
  fido2AuthOptions: () => j("/api/fido2/auth/options", {}),
  transfer: (assertion: any, recipientAddress: string, amount: string, token: string) =>
    j("/api/transfer", { assertion, recipientAddress, amount, token }),
};
