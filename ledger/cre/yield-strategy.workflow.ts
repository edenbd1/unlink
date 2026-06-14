// Chainlink CRE workflow — confidential AI yield strategy + on-chain AI Attestation.
//
// This is the deployable CRE artifact. It runs the SAME strategy logic the
// localhost rig runs (ledger/host/cre-attestation.mjs), but on Chainlink's
// decentralized oracle network: the LLM call goes out over Confidential HTTP so
// the user's private goals and capital never leave the trusted execution
// environment, the DON reaches consensus on the result, and the workflow emits a
// keccak256/ecdsa report — the AI Attestation — that a consumer contract verifies
// before the Execution Account is allowed to act on the allocation.
//
//   trigger:      cron (re-evaluate the mandate on a schedule)
//   capability:   HTTPClient over Confidential HTTP (the AI call stays private)
//   capability:   Consensus (the DON agrees on one allocation)
//   output:       runtime.report(...) -> AI Attestation, written on-chain
//
// Deploy:  cre workflow deploy yield-strategy --target base-sepolia
// Secrets: MISTRAL_API_KEY is registered as a CRE Secret, never in the workflow.
import * as cre from "@chainlink/cre-sdk";

type Config = {
  consumerAddress: `0x${string}`; // contract that gates the EA on a valid attestation
  vaults: { address: `0x${string}`; name: string; apy: number; risk: "low" | "high" }[];
  mandate: { goals: string; amountBase: string };
};

const SYSTEM =
  "You are an autonomous DeFi yield strategist. Diversify the private USDC across " +
  "the given ERC-4626 vaults and return ONLY JSON: { allocations: [{ vaultName, " +
  "pct }] (pct sum to 100), rebalance: { trigger, rule }, blendedApy }.";

// The confidential AI call: routed through Confidential HTTP so the prompt (the
// user's goals + capital) and the response stay inside the TEE.
async function proposeAllocation(runtime: cre.Runtime<Config>, cfg: Config) {
  const http = new cre.capabilities.HTTPClient();
  const user =
    `Goals: ${cfg.mandate.goals}\nCapital: ${cfg.mandate.amountBase} (USDC base units)\n` +
    cfg.vaults.map((v) => `- ${v.name}: ~${v.apy}% APY, ${v.risk} risk`).join("\n");

  const res = await http
    .sendRequest(runtime, {
      url: "https://api.mistral.ai/v1/chat/completions",
      method: "POST",
      // Confidential HTTP: request + response are sealed to the TEE; the API key
      // is injected from CRE Secrets, never present in the workflow source.
      confidential: true,
      headers: { Authorization: `Bearer {{ secrets.MISTRAL_API_KEY }}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "mistral-large-latest",
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      }),
    })
    .result();

  const body = JSON.parse(new TextDecoder().decode(res.body));
  return JSON.parse(body.choices[0].message.content);
}

// keccak256 commitments so the report binds the private inputs/outputs without
// publishing them on-chain.
function commit(s: string): `0x${string}` {
  return cre.utils.keccak256(cre.utils.toBytes(s));
}

const onCron = async (runtime: cre.Runtime<Config>) => {
  const cfg = runtime.config;

  // 1. confidential AI proposal, agreed by the DON via consensus
  const strategy = await cre.consensus.median(runtime, () => proposeAllocation(runtime, cfg));

  // 2. commit inputs + outputs (privacy: digests, not plaintext)
  const vaultKey = cfg.vaults.map((v) => `${v.address}:${v.apy}`).join("|");
  const inputDigest = commit(`${cfg.mandate.goals} ${cfg.mandate.amountBase} ${vaultKey}`);
  const allocKey = strategy.allocations.map((a: any) => `${a.vaultName}:${a.pct}`).join("|");
  const outputDigest = commit(`${allocKey} ${strategy.blendedApy} ${strategy.rebalance.trigger}`);

  // 3. emit the AI Attestation as a signed report (evm/keccak256/ecdsa) and write
  //    it to the consumer that gates the Execution Account.
  const payload = cre.utils.encodePacked(
    ["bytes32", "bytes32", "uint64"],
    [inputDigest, outputDigest, BigInt(runtime.now())],
  );
  const report = runtime
    .report({ encodedPayload: cre.utils.toBase64(payload), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })
    .result();

  const evm = new cre.capabilities.EVMClient();
  await evm
    .writeReport(runtime, { receiver: cfg.consumerAddress, report, gasConfig: { gasLimit: "500000" } })
    .result();

  return { inputDigest, outputDigest, allocations: strategy.allocations };
};

export const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronTrigger();
  // re-evaluate the Ledger-approved mandate every hour
  return [cre.handler(cron.trigger({ schedule: "0 * * * *" }), onCron)];
};

export default initWorkflow;
