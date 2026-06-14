// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================
// AllocationGate — on-chain gate for an attested private-yield allocation
// ============================================================================
//
//   ┌───────────────────────────┐  POST /v1/inference          ┌────────────────┐
//   │ Lunave yield agent        │ ───────────────────────────▶ │ Chainlink      │
//   │ (private profile: goals,  │                              │ Confidential   │
//   │  capital, Unlink balance) │                              │ AI Attester    │
//   └───────────────────────────┘                              │ (LLM in a TEE) │
//                                                               └──────┬─────────┘
//   The Attester runs the allocation inference INSIDE A TEE and POSTs the      │ callback
//   result (allocation + response_digest) to a callback URL (a CRE             │
//   HTTP-trigger endpoint).                                                    ▼
//   ┌────────────────────────────────────────────────────────────────────────┐
//   │ CRE workflow (yield-allocation-workflow/main.ts)                        │
//   │  • parses the allocation + attestation provenance (response_digest)     │
//   │  • ABI-encodes (user, vaults[], bps[], blendedApyBps, approved,         │
//   │                 transcriptHash, inferenceId)                            │
//   │  • runtime.report(...) (DON-signed) then evmClient.writeReport(...)     │
//   └───────────────────────────────┬────────────────────────────────────────┘
//                                   │ report (via KeystoneForwarder)
//                                   ▼
//   ┌────────────────────────────────────────────────────────────────────────┐
//   │ AllocationGate.onReport(metadata, report)  ── THIS CONTRACT             │
//   │  • only the trusted forwarder may call                                  │
//   │  • stores the DON-attested allocation, keyed by user                    │
//   │  • the Execution Account checks approvedAllocation(user) before acting  │
//   └────────────────────────────────────────────────────────────────────────┘
//
// Custody split: the Ledger approves the human MANDATE (bounds) once; this gate
// holds the DON-attested ALLOCATION the agent must stay within. The agent can
// only deploy/rebalance into vaults+weights that were attested here.
//
// Deploys on Base Sepolia (chainId 84532) — the same chain as the Unlink vaults
// and the Execution Account, so the attestation and the execution share one chain.
// The constructor forwarder is the CRE KeystoneForwarder on the target chain
// (the address CRE writes reports through). For `cre ... simulate --broadcast`
// pass the MockKeystoneForwarder for the target; for production pass the live
// KeystoneForwarder. Get the exact Base Sepolia address from the CRE docs / the
// Chainlink desk. The non-broadcast simulation needs no deployed forwarder.
// (Reference Ethereum Sepolia addresses, for comparison: mock
// 0x15fC6ae953E024d975e77382eEeC56A9101f9F88, prod 0xF8344CFd5c43616a4366C34E3EEE75af79a74482.)
// ============================================================================

/// @notice Minimal CRE receiver. The KeystoneForwarder calls onReport with
///         workflow metadata and the ABI-encoded report.
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

contract AllocationGate is IReceiver {
    /// @notice A DON-attested portfolio allocation for one inference run.
    struct Allocation {
        string inferenceId;     // inference-API request id (unique per run)
        address user;
        address[] vaults;       // ERC-4626 vaults to allocate across
        uint16[] bps;           // weight per vault, basis points (sum 10000)
        uint16 blendedApyBps;   // expected blended APY, basis points
        bool approved;          // the Attester approved this allocation
        bytes32 transcriptHash; // SHA-256 digest of the inference transcript (provenance)
        uint256 timestamp;      // block time the allocation was recorded
    }

    /// @notice The only address allowed to deliver reports (the KeystoneForwarder).
    address public immutable forwarder;

    /// @notice keccak256(inferenceId) => the allocation recorded for that run.
    mapping(bytes32 => Allocation) private _byId;

    /// @notice user => key of their most recent attested allocation.
    mapping(address => bytes32) public latestKeyByUser;

    event AllocationAttested(
        bytes32 indexed inferenceIdHash, address indexed user, bool approved, uint16 blendedApyBps, bytes32 transcriptHash
    );

    error UnauthorizedForwarder(address caller);

    modifier onlyForwarder() {
        if (msg.sender != forwarder) revert UnauthorizedForwarder(msg.sender);
        _;
    }

    constructor(address forwarder_) {
        forwarder = forwarder_;
    }

    /// @inheritdoc IReceiver
    /// @dev The decoded tuple must match the workflow's encodeAbiParameters call.
    function onReport(bytes calldata, bytes calldata report) external onlyForwarder {
        (
            address user,
            address[] memory vaults,
            uint16[] memory bps,
            uint16 blendedApyBps,
            bool approved,
            bytes32 transcriptHash,
            string memory inferenceId
        ) = abi.decode(report, (address, address[], uint16[], uint16, bool, bytes32, string));

        bytes32 key = keccak256(bytes(inferenceId));
        _byId[key] = Allocation({
            inferenceId: inferenceId,
            user: user,
            vaults: vaults,
            bps: bps,
            blendedApyBps: blendedApyBps,
            approved: approved,
            transcriptHash: transcriptHash,
            timestamp: block.timestamp
        });
        latestKeyByUser[user] = key;

        emit AllocationAttested(key, user, approved, blendedApyBps, transcriptHash);
    }

    /// @notice The user's most recent attested allocation (vaults + weights).
    ///         The Execution Account reads this and refuses any deploy/rebalance
    ///         that would leave the attested vault set or exceed an attested weight.
    function approvedAllocation(address user)
        external
        view
        returns (bool approved, address[] memory vaults, uint16[] memory bps, uint16 blendedApyBps, bytes32 transcriptHash)
    {
        Allocation storage a = _byId[latestKeyByUser[user]];
        return (a.approved, a.vaults, a.bps, a.blendedApyBps, a.transcriptHash);
    }

    /// @notice Full allocation record, by inference id.
    function getAllocationById(string calldata inferenceId) external view returns (Allocation memory) {
        return _byId[keccak256(bytes(inferenceId))];
    }

    /// @notice True if the user's most recent attested allocation is approved.
    function isApproved(address user) external view returns (bool) {
        return _byId[latestKeyByUser[user]].approved;
    }
}
