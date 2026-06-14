// ============================================================================
// Yield Allocation Attestation Workflow (CRE, TypeScript)
// ============================================================================
// Flow:
//   1. The Chainlink Confidential AI Attester analyses a user's PRIVATE financial
//      profile (yield goals, capital, Unlink-pool balance) INSIDE A TEE, decides
//      a portfolio allocation across ERC-4626 vaults, and POSTs the result to a
//      callback URL.
//   2. That callback URL is this workflow's HTTP-trigger endpoint. It parses the
//      allocation, uses the inference response digest as the transcript hash,
//      ABI-encodes the allocation, generates a DON-signed report, and writes it
//      on-chain via the EVM client.
//   3. The on-chain AllocationGate consumer stores the attested allocation and
//      exposes approvedAllocation(user) so the Execution Account can only
//      deploy/rebalance WITHIN the vaults + weights the Attester signed off on.
//
// Reads only fields present in simulation/allocation-callback.json.
// QuickJS/WASM runtime: no process.env / Node Buffer / crypto; viem does all ABI
// encoding and hashing; Solidity integers are bigint.
// ============================================================================

import {
	EVMClient,
	HTTPCapability,
	handler,
	prepareReportRequest,
	Runner,
	type HTTPPayload,
	type Runtime,
} from "@chainlink/cre-sdk";
import {
	bytesToString,
	encodeAbiParameters,
	getAddress,
	keccak256,
	parseAbiParameters,
	sha256,
	stringToHex,
	toHex,
	type Address,
	type Hex,
} from "viem";

// --- Config (config.staging.json / config.production.json) ------------------

type AuthorizedKey = {
	type?: "KEY_TYPE_UNSPECIFIED" | "KEY_TYPE_ECDSA_EVM";
	publicKey?: string;
};

export type Config = {
	authorizedKeys: AuthorizedKey[];
	consumerAddress: `0x${string}`;
	chainSelectorName: string;
	userAddress: `0x${string}`; // the Unlink/Ledger user the allocation is attested for
};

// --- Inference-API callback (only the fields this workflow uses) ------------
// See simulation/allocation-callback.json.
type InferenceCallback = {
	id?: string;
	status?: string; // "completed" | "failed"
	output?: string; // allocation as JSON, wrapped in a ```json fence
	resources?: { digest?: string; request_digest?: string; response_digest?: string }[];
};

// The JSON the LLM is asked to return (see simulation/inference-prompt.txt).
type AllocationEntry = { vault?: string; name?: string; bps?: number };
type LlmAllocation = {
	approved?: boolean;
	risk_level?: string;
	blended_apy_bps?: number;
	reason?: string;
	allocations?: AllocationEntry[];
};

// ABI shape written on-chain and decoded by AllocationGate.onReport():
//   (address user, address[] vaults, uint16[] bps, uint16 blendedApyBps,
//    bool approved, bytes32 transcriptHash, string inferenceId)
const ALLOCATION_ABI =
	"address user, address[] vaults, uint16[] bps, uint16 blendedApyBps, bool approved, bytes32 transcriptHash, string inferenceId";

// --- Helpers ----------------------------------------------------------------

/** The LLM output is JSON wrapped in a ```json … ``` fence; strip it and parse. */
const parseAllocation = (output: string): LlmAllocation => {
	const fenced = output.trim().match(/^```(?:[a-zA-Z0-9]+)?\s*([\s\S]*?)\s*```$/);
	return JSON.parse(fenced ? fenced[1].trim() : output) as LlmAllocation;
};

/** Normalize a 32-byte hex digest (with or without 0x) to a bytes32 value. */
const toBytes32 = (hex: string): Hex => {
	const h = hex.replace(/^0[xX]/, "");
	if (h.length !== 64 || !/^[0-9a-fA-F]+$/.test(h)) {
		throw new Error(`expected a 32-byte hex digest, got "${hex}"`);
	}
	return `0x${h.toLowerCase()}` as Hex;
};

// --- HTTP trigger handler — receives the inference-API callback -------------

export const onAllocationCallback = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
	// 1. Decode the HTTP body bytes into the callback object.
	const callback = JSON.parse(bytesToString(payload.input)) as InferenceCallback;
	runtime.log(
		`Inference callback received: id=${callback.id ?? "unknown"} status=${callback.status ?? "unknown"}`,
	);

	// 2. Only act on completed inferences.
	if (callback.status !== "completed") {
		runtime.log(`Status is not "completed"; skipping on-chain write.`);
		return JSON.stringify({ id: callback.id ?? null, status: callback.status ?? null, action: "skipped" });
	}

	// 3. Parse the allocation the Attester decided.
	const decision = parseAllocation(callback.output ?? "");
	const approved = decision.approved === true;
	const entries = (decision.allocations ?? []).filter((a) => a.vault && (a.bps ?? 0) > 0);
	if (entries.length === 0) throw new Error("no allocations in inference output");

	const vaults = entries.map((a) => getAddress(a.vault as string)) as Address[];
	const bps = entries.map((a) => Math.round(Number(a.bps)));
	const totalBps = bps.reduce((s, b) => s + b, 0);
	if (totalBps !== 10000) runtime.log(`WARNING: weights sum to ${totalBps} bps, expected 10000`);
	const blendedApyBps = Math.round(Number(decision.blended_apy_bps ?? 0));
	runtime.log(
		`Allocation: approved=${approved} risk=${decision.risk_level ?? "n/a"} blendedApy=${blendedApyBps}bps ` +
			entries.map((a) => `${a.bps}bps ${a.name ?? a.vault}`).join(", "),
	);

	// 4. Use the inference response digest as the on-chain transcript hash
	//    (fall back to hashing the raw output if no response digest is present).
	const responseDigest = callback.resources?.[0]?.response_digest;
	const transcriptHash = responseDigest ? toBytes32(responseDigest) : sha256(stringToHex(callback.output ?? ""));
	const allocationsHash = keccak256(
		encodeAbiParameters(parseAbiParameters("address[], uint16[]"), [vaults, bps]),
	);
	runtime.log(`transcriptHash=${transcriptHash} allocationsHash=${allocationsHash}`);

	// 5. ABI-encode the allocation for AllocationGate.onReport().
	const user = getAddress(runtime.config.userAddress);
	const inferenceId = callback.id ?? "";
	const encodedPayload = encodeAbiParameters(parseAbiParameters(ALLOCATION_ABI), [
		user,
		vaults,
		bps,
		blendedApyBps,
		approved,
		transcriptHash,
		inferenceId,
	]);

	// 6. Generate a DON-signed report and write it on-chain. Guarded so the
	//    workflow always returns a summary even when the write can't be broadcast
	//    (e.g. simulation without --broadcast).
	let write: Record<string, unknown> = { attempted: false };
	try {
		const signedReport = runtime.report(prepareReportRequest(encodedPayload)).result();

		const selectors = EVMClient.SUPPORTED_CHAIN_SELECTORS;
		const chainSelector = selectors[runtime.config.chainSelectorName as keyof typeof selectors];
		if (chainSelector === undefined) {
			throw new Error(`unsupported chainSelectorName: ${runtime.config.chainSelectorName}`);
		}

		const reply = new EVMClient(chainSelector)
			.writeReport(runtime, {
				receiver: runtime.config.consumerAddress,
				report: signedReport,
				gasConfig: { gasLimit: "500000" },
			})
			.result();

		const txHash = reply.txHash ? toHex(reply.txHash) : null;
		const errorMessage = reply.errorMessage ?? null;
		write = { attempted: true, txHash, error: errorMessage };
		runtime.log(`On-chain write: txHash=${txHash ?? "n/a"} error=${errorMessage ?? "n/a"}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		write = { attempted: true, error: message };
		runtime.log(`On-chain write skipped (expected in simulation without --broadcast): ${message}`);
	}

	// 7. Return a JSON summary.
	return JSON.stringify({
		id: callback.id ?? null,
		status: callback.status,
		user,
		approved,
		riskLevel: decision.risk_level ?? null,
		blendedApyBps,
		allocations: entries.map((a) => ({ vault: getAddress(a.vault as string), name: a.name ?? null, bps: a.bps })),
		allocationsHash,
		transcriptHash,
		consumerAddress: runtime.config.consumerAddress,
		chainSelectorName: runtime.config.chainSelectorName,
		write,
	});
};

// --- Workflow wiring --------------------------------------------------------

export const initWorkflow = (config: Config) => {
	const http = new HTTPCapability();
	return [handler(http.trigger({ authorizedKeys: config.authorizedKeys }), onAllocationCallback)];
};

export async function main() {
	const runner = await Runner.newRunner<Config>();
	await runner.run(initWorkflow);
}

main();
