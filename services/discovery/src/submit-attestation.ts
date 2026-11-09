import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, recoverAddress, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, DEFAULT_RPC } from "./config.js";
import { assertDistinctArchiveProviders, verifyOnSecondaryArchive } from "./secondary-archive.js";

type Payload = {
  action: "submit" | "challenge";
  attestation: {
    chainId: number;
    verifyingContract: Address;
    marketId: string;
    outcome: boolean;
    observationBlock: string;
    observationTimestamp: string;
    observationBlockHash: Hex;
    evidenceHash: Hex;
    fdvValue: string;
    resolverVersion: number;
  };
  evidence: Record<string, unknown>;
  signatures: Hex[];
};

const file = process.argv[2];
if (!file) throw new Error("Usage: npm run submit:attestation -- <attestation-bundle.json>");
const configuredAddress = process.env.LAUNCHCAST_V2_ADDRESS ?? "";
if (!/^0x[0-9a-fA-F]{40}$/.test(configuredAddress)) throw new Error("Set LAUNCHCAST_V2_ADDRESS to the deployed V2 contract.");
const contractAddress = configuredAddress as Address;
const privateKey = process.env.RESOLVER_PRIVATE_KEY as Hex | undefined;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("Set RESOLVER_PRIVATE_KEY to the existing Launchcast owner wallet key; it signs and submits the settlement.");
const account = privateKeyToAccount(privateKey);
const rpcUrl = process.env.ARCHIVE_RPC_URL || process.env.RPC_URL || DEFAULT_RPC;
const chain = {
  id: CHAIN_ID, name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Robinhood Testnet ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } }, testnet: true,
} as const;
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });
const abi = parseAbi([
  "function getMarket(uint256 marketId) view returns ((uint8 marketType,uint8 status,address token,address curve,address pairCurrency,uint64 launchAt,uint64 observationAt,uint64 closeAt,uint64 maxObservationLag,uint64 observationBlock,uint64 observationTimestamp,uint64 challengeEndsAt,bytes32 observationBlockHash,bytes32 evidenceHash,bytes32 challengeEvidenceHash,uint256 targetFdv,uint256 attestedFdv,uint128 yesPool,uint128 noPool,bool outcomeYes,uint16 feeBps,address feeRecipient,uint32 resolverVersion,address resolver))",
  "function attestationDigest(uint256 marketId,bool outcomeYes,uint64 observationBlock,uint64 observationTimestamp,bytes32 observationBlockHash,bytes32 evidenceHash,uint256 fdvValue) view returns (bytes32)",
  "function submitAttestation(uint256 marketId,bool outcomeYes,uint64 observationBlock,uint64 observationTimestamp,bytes32 observationBlockHash,bytes32 evidenceHash,uint256 fdvValue,bytes[] signatures)",
  "function challengeAttestation(uint256 marketId,bool outcomeYes,uint64 observationBlock,uint64 observationTimestamp,bytes32 observationBlockHash,bytes32 evidenceHash,uint256 fdvValue,bytes[] signatures)",
]);

async function main() {
  if (await publicClient.getChainId() !== CHAIN_ID) throw new Error("Refusing to relay on a chain other than Robinhood Chain Testnet (46630).");
  const payload = JSON.parse(await readFile(file, "utf8")) as Payload;
  const a = payload.attestation;
  if (!payload || !["submit", "challenge"].includes(payload.action) || !a || !payload.evidence) throw new Error("Attestation bundle schema is invalid.");
  if (a.chainId !== CHAIN_ID || a.verifyingContract.toLowerCase() !== contractAddress.toLowerCase()) throw new Error("Attestation is bound to a different chain or V2 contract.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.evidenceHash) || !/^0x[0-9a-fA-F]{64}$/.test(a.observationBlockHash)) throw new Error("Evidence or block hash is malformed.");
  if (keccak256(stringToHex(JSON.stringify(payload.evidence))).toLowerCase() !== a.evidenceHash.toLowerCase()) throw new Error("Evidence JSON does not reproduce the signed evidence hash.");
  if (payload.signatures.length !== 1 || payload.signatures.some(sig => !/^0x[0-9a-fA-F]{130}$/.test(sig))) throw new Error("Exactly one 65-byte owner signature is required.");

  const marketId = BigInt(a.marketId);
  const observationBlock = BigInt(a.observationBlock);
  const observationTimestamp = BigInt(a.observationTimestamp);
  const fdvValue = BigInt(a.fdvValue);
  const market = await publicClient.readContract({ address: contractAddress, abi, functionName: "getMarket", args: [marketId] });
  if (String(payload.evidence.marketId) !== a.marketId || Number(payload.evidence.chainId) !== CHAIN_ID) throw new Error("Evidence package is bound to a different chain or market.");
  if (String(payload.evidence.token).toLowerCase() !== market.token.toLowerCase()
    || String(payload.evidence.curve).toLowerCase() !== market.curve.toLowerCase()) throw new Error("Evidence token or curve does not match the on-chain market.");
  const probeEvidence = payload.evidence.probe as Record<string, unknown> | undefined;
  const evidenceBlock = payload.evidence.observationBlock ?? probeEvidence?.observationBlock;
  const evidenceBlockHash = payload.evidence.observationBlockHash ?? probeEvidence?.observationBlockHash;
  const evidenceTimestamp = payload.evidence.observationTimestamp ?? payload.evidence.observationBlockTimestamp ?? probeEvidence?.observationBlockTimestamp;
  if (String(evidenceBlock) !== a.observationBlock
    || String(evidenceBlockHash).toLowerCase() !== a.observationBlockHash.toLowerCase()
    || String(evidenceTimestamp) !== a.observationTimestamp) {
    throw new Error("Evidence package observation block data does not match the signed attestation.");
  }
  if (market.marketType === 0) {
    if (payload.evidence.outcomeYes !== a.outcome) throw new Error("Graduation evidence outcome does not match the signed attestation.");
  } else {
    const expectedType = market.marketType === 1 ? "fdv12" : "fdv24";
    if (payload.evidence.marketType !== expectedType
      || String(payload.evidence.pairCurrency).toLowerCase() !== market.pairCurrency.toLowerCase()
      || String(payload.evidence.targetFdvPairScaled1e18) !== market.targetFdv.toString()
      || String(payload.evidence.fdvPairScaled1e18) !== a.fdvValue
      || payload.evidence.outcome !== a.outcome) {
      throw new Error("FDV evidence type, pair, fixed threshold, value or outcome does not match the signed attestation.");
    }
  }
  if (market.resolverVersion !== a.resolverVersion) throw new Error("Attestation uses a resolver version different from the market's snapshot.");
  if (BigInt(String(payload.evidence.launchAt)) !== market.launchAt
    || BigInt(String(payload.evidence.observationAt)) !== market.observationAt) {
    throw new Error("Evidence launch or target observation time does not match the on-chain market.");
  }
  if (observationTimestamp > market.observationAt || market.observationAt - observationTimestamp > market.maxObservationLag) throw new Error("Observation timestamp violates the market's on-chain observation window.");
  const block = await publicClient.getBlock({ blockNumber: observationBlock });
  if (!block.hash || block.hash.toLowerCase() !== a.observationBlockHash.toLowerCase() || block.timestamp !== observationTimestamp) throw new Error("Observation block hash or timestamp does not match canonical chain data.");
  if (market.marketType === 0) {
    if (fdvValue !== 0n) throw new Error("Graduation attestations must carry fdvValue = 0.");
  } else if (a.outcome !== (fdvValue >= market.targetFdv)) {
    throw new Error("FDV outcome does not match the market's fixed pair-denominated threshold.");
  }

  if (payload.action === "submit") {
    if (market.status !== 0) throw new Error("Initial attestation requires an Open market.");
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < market.observationAt || now > market.observationAt + 86400n) throw new Error("Initial attestation is outside the contract's 24-hour submission window.");
  } else {
    if (market.status !== 1) throw new Error("A challenge requires a market in the Challenged state.");
    if (BigInt(Math.floor(Date.now() / 1000)) > market.challengeEndsAt) throw new Error("The challenge window has closed.");
    if (a.outcome === market.outcomeYes && a.evidenceHash.toLowerCase() === market.evidenceHash.toLowerCase()) throw new Error("Challenge evidence must conflict with the initial attestation.");
  }

  const digest = await publicClient.readContract({ address: contractAddress, abi, functionName: "attestationDigest", args: [marketId, a.outcome, observationBlock, observationTimestamp, a.observationBlockHash, a.evidenceHash, fdvValue] });
  if (payload.action === "submit") {
    verifyOnSecondaryArchive(market.marketType === 0 ? "resolve-graduation" : "resolve-fdv", marketId.toString(), {
      evidenceHash: a.evidenceHash,
      digest,
    });
  } else {
    // Challenges are checked against the second provider's identity here;
    // a dedicated challenge-evidence replay remains a separate release gate.
    assertDistinctArchiveProviders(process.env.ARCHIVE_RPC_URL, process.env.SECONDARY_ARCHIVE_RPC_URL);
  }
  const signer = await recoverAddress({ hash: digest, signature: payload.signatures[0] });
  if (signer.toLowerCase() !== market.resolver.toLowerCase()) throw new Error("Signature is not from the market's snapshotted owner wallet.");
  const signatures = payload.signatures;

  const hash = payload.action === "submit"
    ? await walletClient.writeContract({ address: contractAddress, abi, functionName: "submitAttestation", args: [marketId, a.outcome, observationBlock, observationTimestamp, a.observationBlockHash, a.evidenceHash, fdvValue, signatures] })
    : await walletClient.writeContract({ address: contractAddress, abi, functionName: "challengeAttestation", args: [marketId, a.outcome, observationBlock, observationTimestamp, a.observationBlockHash, a.evidenceHash, fdvValue, signatures] });
  console.log(`Submitted ${payload.action} transaction: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Attestation transaction reverted: ${hash}`);
  console.log(JSON.stringify({ status: "confirmed", action: payload.action, marketId: a.marketId, transactionHash: hash, blockNumber: receipt.blockNumber.toString(), resolverSigner: signer }, null, 2));
}
main().catch(error => { console.error("Attestation relay failed closed."); console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
