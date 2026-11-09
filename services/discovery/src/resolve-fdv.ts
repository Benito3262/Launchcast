import { execFileSync } from "node:child_process";
import { createPublicClient, hashTypedData, http, keccak256, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertV6FactoryCode, CHAIN_ID, DEFAULT_RPC, V6_FACTORY_ADDRESS } from "./config.js";
import { findBlockAtOrBeforeTimestamp } from "./observation.js";
import { verifyOnSecondaryArchive } from "./secondary-archive.js";

const [marketIdArg] = process.argv.slice(2);
if (!marketIdArg || !/^\d+$/.test(marketIdArg)) throw new Error("Usage: npm run resolve:fdv -- <on-chain-market-id>");
const marketId = BigInt(marketIdArg);
const rpcUrl = process.env.ARCHIVE_RPC_URL || process.env.RPC_URL || DEFAULT_RPC;
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });
const configuredV2Address = process.env.LAUNCHCAST_V2_ADDRESS;
if (!configuredV2Address || !/^0x[0-9a-fA-F]{40}$/.test(configuredV2Address)) throw new Error("Set LAUNCHCAST_V2_ADDRESS to the deployed V2 contract.");
const v2Address = configuredV2Address as Address;
const v2Abi = parseAbi([
  "function getMarket(uint256 marketId) view returns ((uint8 marketType,uint8 status,address token,address curve,address pairCurrency,uint64 launchAt,uint64 observationAt,uint64 closeAt,uint64 maxObservationLag,uint64 observationBlock,uint64 observationTimestamp,uint64 challengeEndsAt,bytes32 observationBlockHash,bytes32 evidenceHash,bytes32 challengeEvidenceHash,uint256 targetFdv,uint256 attestedFdv,uint128 yesPool,uint128 noPool,bool outcomeYes,uint16 feeBps,address feeRecipient,uint32 resolverVersion,address resolver))",
]);
const factory = V6_FACTORY_ADDRESS;
const launchCreated = parseAbiItem("event LaunchCreated(uint256 indexed launchId,address indexed launcher,address indexed token,address curve,string name,string symbol,string metadataURI,address pairCurrency,uint16 taxBps,uint64 packedWeights,address projectTreasury,uint256 targetPairUnits,uint256 netPersonal,uint256 giftNetTotal,bytes32 giftRoot,uint256 giftCount)");
async function findLaunchEvent(token: Address, launchAt: bigint) {
  const head = await client.getBlockNumber();
  const approximate = await findBlockAtOrBeforeTimestamp(
    head, launchAt, async blockNumber => (await client.getBlock({ blockNumber })).timestamp,
  );
  // The event must be at or before the final block carrying launchAt's timestamp.
  // A bounded lookback avoids a full-chain scan while still covering same-second blocks.
  const lookback = BigInt(process.env.LAUNCH_EVENT_LOOKBACK_BLOCKS ?? "5000");
  const fromBlock = approximate.blockNumber > lookback ? approximate.blockNumber - lookback : 0n;
  const logs = await client.getLogs({ address: factory, event: launchCreated, args: { token }, fromBlock, toBlock: approximate.blockNumber });
  if (logs.length !== 1) throw new Error(`Expected exactly one LaunchCreated event in the launch-time window; found ${logs.length}. Increase LAUNCH_EVENT_LOOKBACK_BLOCKS only after checking the canonical launch time.`);
  return { log: logs[0], head };
}

async function main() {
  if (await client.getChainId() !== CHAIN_ID) throw new Error(`Resolver only supports chain ${CHAIN_ID}.`);
  await assertV6FactoryCode(client);
  const market = await client.readContract({ address: v2Address, abi: v2Abi, functionName: "getMarket", args: [marketId] }) as unknown as {
    marketType: number; status: number; token: Address; curve: Address; pairCurrency: Address;
    launchAt: bigint; observationAt: bigint; maxObservationLag: bigint; targetFdv: bigint; resolverVersion: number;
  };
  if (market.marketType !== 1 && market.marketType !== 2) throw new Error("This resolver handles FDV12/FDV24 markets only.");
  if (market.status !== 0) throw new Error("Market is not Open; refusing to attest a closed, challenged, disputed, or resolved market.");
  const expectedHours = market.marketType === 1 ? 12n : 24n;
  if (market.observationAt !== market.launchAt + expectedHours * 3600n) throw new Error("On-chain market schedule does not match its market type.");
  const head = await client.getBlock({ blockTag: "latest" });
  if (head.timestamp < market.observationAt) throw new Error("Observation time has not arrived yet.");
  const { log, head: headNumber } = await findLaunchEvent(market.token, market.launchAt);
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.args.launchId === undefined || !log.args.curve || !log.args.pairCurrency) {
    throw new Error("LaunchCreated log is missing required canonical fields.");
  }
  if (log.args.curve.toLowerCase() !== market.curve.toLowerCase() || log.args.pairCurrency.toLowerCase() !== market.pairCurrency.toLowerCase()) {
    throw new Error("Market token/curve/pair does not match its canonical LaunchCreated event.");
  }
  if (headNumber - log.blockNumber < BigInt(process.env.CONFIRMATIONS ?? "12")) throw new Error("LaunchCreated event has not reached configured confirmation depth.");
  const launchBlock = await client.getBlock({ blockNumber: log.blockNumber });
  if (launchBlock.hash.toLowerCase() !== log.blockHash.toLowerCase() || launchBlock.timestamp !== market.launchAt) throw new Error("Launch event block is noncanonical or its timestamp differs from market launchAt.");

  const probeText = execFileSync("npx", ["tsx", "src/probe-v4-observation.ts", market.observationAt.toString(), market.token, process.env.MAX_PRICE_STALENESS_SECONDS ?? "3600"], {
    cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", env: process.env, maxBuffer: 8 * 1024 * 1024,
  });
  const probe = JSON.parse(probeText) as Record<string, unknown>;
  if (Number(probe.chainId) !== CHAIN_ID) throw new Error("Historical probe returned the wrong chain.");
  if (String(probe.token).toLowerCase() !== market.token.toLowerCase()) {
    throw new Error("Historical probe token does not match the on-chain market.");
  }
  if (String(probe.curve).toLowerCase() !== market.curve.toLowerCase()) {
    throw new Error("Historical probe curve does not match the on-chain market.");
  }
  if (String(probe.pairCurrency).toLowerCase() !== market.pairCurrency.toLowerCase()) {
    throw new Error("Historical probe pair currency does not match the on-chain market.");
  }
  if (BigInt(String(probe.targetTimestamp)) !== market.observationAt) {
    throw new Error("Historical probe target timestamp does not match the on-chain market.");
  }
  if (probe.status !== "fresh" || (probe.fdvEligibility as { eligible?: boolean } | undefined)?.eligible !== true) {
    throw new Error(`Historical FDV evidence is ineligible: ${JSON.stringify(probe.fdvEligibility ?? probe.status)}.`);
  }
  if (probe.fdvPairScaled1e18 === null || probe.observationBlock === undefined || probe.observationBlockHash === undefined || probe.observationBlockTimestamp === undefined) {
    throw new Error("Historical FDV probe did not return a complete observation.");
  }
  const observationTimestamp = BigInt(String(probe.observationBlockTimestamp));
  if (observationTimestamp > market.observationAt || market.observationAt - observationTimestamp > market.maxObservationLag) {
    throw new Error("Selected observation block violates this market's on-chain maxObservationLag.");
  }
  const fdvValue = BigInt(String(probe.fdvPairScaled1e18));
  const outcome = fdvValue >= market.targetFdv;
  // Exclude head-dependent diagnostics (for example, current pool storage) so
  // independent resolvers produce the same hash for the same historical snapshot.
  const canonicalProbe = Object.fromEntries([
    "chainId", "token", "curve", "pairCurrency", "pairSymbol", "pairDecimals",
    "targetTimestamp", "observationBlock", "observationBlockTimestamp", "observationBlockHash",
    "poolId", "sourceEvent", "sourceEventBlock", "sourceEventTimestamp", "sourceEventBlockHash",
    "sourceEventLogIndex", "sourceEventTransaction", "secondsSinceLastPriceEventAtTarget",
    "maxStalenessSeconds", "status", "sqrtPriceX96", "pricePairPerTokenScaled1e18",
    "fdvEligibility", "totalSupplyAtObservation", "supplyStatus", "fdvPairScaled1e18",
  ].map(key => [key, probe[key]]));
  const evidence = {
    schema: "launchcast-fdv-evidence-v1", chainId: CHAIN_ID, marketId: marketId.toString(),
    marketType: market.marketType === 1 ? "fdv12" : "fdv24", token: market.token, factory,
    launchId: log.args.launchId.toString(), launchAt: market.launchAt.toString(), launchBlock: log.blockNumber.toString(),
    launchBlockHash: log.blockHash, launchTransactionHash: log.transactionHash, launchLogIndex: log.logIndex,
    observationAt: market.observationAt.toString(), targetFdvPairScaled1e18: market.targetFdv.toString(),
    fdvPairScaled1e18: fdvValue.toString(), outcome, probe: canonicalProbe,
    policy: { confirmations: Number(process.env.CONFIRMATIONS ?? "12"), maxPriceStalenessSeconds: Number(process.env.MAX_PRICE_STALENESS_SECONDS ?? "3600"), maxObservationLag: market.maxObservationLag.toString(), supplySource: "historical totalSupply at observation block only" },
  };
  const evidenceHash = keccak256(new TextEncoder().encode(JSON.stringify(evidence)));
  const observationBlock = BigInt(String(probe.observationBlock));
  const observationBlockHash = String(probe.observationBlockHash) as Hex;
  const domain = { name: "LaunchcastV2", version: "1", chainId: CHAIN_ID, verifyingContract: v2Address } as const;
  const types = { MarketAttestation: [
    { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    { name: "marketId", type: "uint256" }, { name: "outcome", type: "bool" },
    { name: "observationBlock", type: "uint64" }, { name: "observationTimestamp", type: "uint64" },
    { name: "observationBlockHash", type: "bytes32" }, { name: "evidenceHash", type: "bytes32" },
    { name: "fdvValue", type: "uint256" }, { name: "resolverVersion", type: "uint32" },
  ] } as const;
  const message = { chainId: BigInt(CHAIN_ID), verifyingContract: v2Address, marketId, outcome, observationBlock, observationTimestamp, observationBlockHash, evidenceHash, fdvValue, resolverVersion: market.resolverVersion };
  const digest = hashTypedData({ domain, types, primaryType: "MarketAttestation", message });
  const privateKey = process.env.RESOLVER_PRIVATE_KEY as Hex | undefined;
  if (privateKey && process.env.SECONDARY_ARCHIVE_REPLAY === "1") {
    throw new Error("A secondary archive replay must never sign an attestation.");
  }
  if (privateKey) verifyOnSecondaryArchive("resolve-fdv", marketId.toString(), { evidenceHash, digest });
  let signer: Address | null = null;
  let signature: Hex | null = null;
  if (privateKey) {
    const account = privateKeyToAccount(privateKey);
    signer = account.address;
    signature = await account.signTypedData({ domain, types, primaryType: "MarketAttestation", message });
    if ((market as unknown as { resolver: Address }).resolver.toLowerCase() !== signer.toLowerCase()) {
      throw new Error("Configured signer is not the market's snapshotted owner wallet.");
    }
  }
  console.log(JSON.stringify({ status: signature ? "signed_evidence_ready" : "unsigned_evidence_ready", evidenceHash, digest, signer, signature,
    attestation: { ...message, chainId: CHAIN_ID, marketId: marketId.toString(), observationBlock: observationBlock.toString(), observationTimestamp: observationTimestamp.toString(), fdvValue: fdvValue.toString() }, evidence }, null, 2));
}

main().catch(error => { console.error("FDV resolver failed closed."); console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
