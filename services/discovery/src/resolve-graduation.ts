import { createPublicClient, encodeAbiParameters, hashTypedData, http, keccak256, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertV6FactoryCode, CHAIN_ID, DEFAULT_RPC, V6_FACTORY_ADDRESS } from "./config.js";
import { findBlockAtOrBeforeTimestamp } from "./observation.js";
import { determineGraduationOutcome } from "./graduation.js";
import { verifyOnSecondaryArchive } from "./secondary-archive.js";

const [marketIdArg] = process.argv.slice(2);
if (!marketIdArg || !/^\d+$/.test(marketIdArg)) throw new Error("Usage: npm run resolve:graduation -- <on-chain-market-id>");
const marketId = BigInt(marketIdArg);
const rpcUrl = process.env.ARCHIVE_RPC_URL || process.env.RPC_URL || DEFAULT_RPC;
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });
const configuredV2Address = process.env.LAUNCHCAST_V2_ADDRESS ?? "";
if (!/^0x[0-9a-fA-F]{40}$/.test(configuredV2Address)) throw new Error("Set LAUNCHCAST_V2_ADDRESS to the deployed V2 contract.");
const v2Address = configuredV2Address as Address;
const factory = V6_FACTORY_ADDRESS;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const v2Abi = parseAbi([
  "function getMarket(uint256 marketId) view returns ((uint8 marketType,uint8 status,address token,address curve,address pairCurrency,uint64 launchAt,uint64 observationAt,uint64 closeAt,uint64 maxObservationLag,uint64 observationBlock,uint64 observationTimestamp,uint64 challengeEndsAt,bytes32 observationBlockHash,bytes32 evidenceHash,bytes32 challengeEvidenceHash,uint256 targetFdv,uint256 attestedFdv,uint128 yesPool,uint128 noPool,bool outcomeYes,uint16 feeBps,address feeRecipient,uint32 resolverVersion,address[3] resolvers))",
]);
const factoryAbi = parseAbi([
  "function isV6Token(address token) view returns (bool)",
  "function curveOf(address token) view returns (address)",
  "function locker() view returns (address)",
  "function poolManager() view returns (address)",
  "function hook() view returns (address)",
]);
const curveAbi = parseAbi([
  "function complete() view returns (bool)",
  "function poolId() view returns (bytes32)",
  "function pairCurrency() view returns (address)",
]);
const lockerAbi = parseAbi([
  "function poolKeyOf(address token) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))",
]);
const launchCreated = parseAbiItem("event LaunchCreated(uint256 indexed launchId,address indexed launcher,address indexed token,address curve,string name,string symbol,string metadataURI,address pairCurrency,uint16 taxBps,uint64 packedWeights,address projectTreasury,uint256 targetPairUnits,uint256 netPersonal,uint256 giftNetTotal,bytes32 giftRoot,uint256 giftCount)");
const v4Initialize = parseAbiItem("event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)");
const v4ModifyLiquidity = parseAbiItem("event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)");
const extSloadAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const POOLS_SLOT = 6n;

async function main() {
  if (await client.getChainId() !== CHAIN_ID) throw new Error(`Resolver only supports chain ${CHAIN_ID}.`);
  await assertV6FactoryCode(client);
  const market = await client.readContract({ address: v2Address, abi: v2Abi, functionName: "getMarket", args: [marketId] });
  if (market.marketType !== 0) throw new Error("This resolver handles Graduation markets only.");
  if (market.status !== 0 && market.status !== 1) throw new Error("Market must be Open or Challenged to produce independently verifiable evidence.");
  const latest = await client.getBlock({ blockTag: "latest" });
  if (latest.timestamp < market.observationAt) throw new Error("Graduation observation time has not arrived.");
  const observation = await findBlockAtOrBeforeTimestamp(latest.number, market.observationAt, async n => (await client.getBlock({ blockNumber: n })).timestamp);
  if (market.observationAt - observation.timestamp > market.maxObservationLag) throw new Error("No sufficiently recent canonical block exists at the graduation observation time.");
  const [isV6, mappedCurve, curveComplete, poolManager, locker, activeHook, curvePoolId, curvePairCurrency] = await Promise.all([
    client.readContract({ address: factory, abi: factoryAbi, functionName: "isV6Token", args: [market.token], blockNumber: observation.blockNumber }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: "curveOf", args: [market.token], blockNumber: observation.blockNumber }),
    client.readContract({ address: market.curve, abi: curveAbi, functionName: "complete", blockNumber: observation.blockNumber }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: "poolManager", blockNumber: observation.blockNumber }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: "locker", blockNumber: observation.blockNumber }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: "hook", blockNumber: observation.blockNumber }),
    client.readContract({ address: market.curve, abi: curveAbi, functionName: "poolId", blockNumber: observation.blockNumber }),
    client.readContract({ address: market.curve, abi: curveAbi, functionName: "pairCurrency", blockNumber: observation.blockNumber }),
  ]);
  if (!isV6) throw new Error("Token was not registered as a V6 token at the observation block.");
  if (mappedCurve.toLowerCase() !== market.curve.toLowerCase()) throw new Error("Market curve does not match the V6 factory's historical curve mapping.");
  const poolKey = await client.readContract({ address: locker, abi: lockerAbi, functionName: "poolKeyOf", args: [market.token], blockNumber: observation.blockNumber });
  const poolId = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
  ));
  if (poolId.toLowerCase() !== curvePoolId.toLowerCase()) throw new Error("V6 curve poolId does not match the locker pool key.");
  const currencies = [poolKey.currency0.toLowerCase(), poolKey.currency1.toLowerCase()];
  if (!currencies.includes(market.token.toLowerCase()) || !currencies.includes(curvePairCurrency.toLowerCase()) || poolKey.hooks.toLowerCase() !== activeHook.toLowerCase()) {
    throw new Error("V6 pool key does not match the token, quote currency, or active factory hook.");
  }
  if (curvePairCurrency.toLowerCase() !== ZERO_ADDRESS || market.pairCurrency.toLowerCase() !== ZERO_ADDRESS) {
    throw new Error("Launchcast Graduation markets currently support only native-ETH-paired V6 tokens; this market's pair currency must be zero-address.");
  }
  const launchTimeBlock = await findBlockAtOrBeforeTimestamp(latest.number, market.launchAt, async n => (await client.getBlock({ blockNumber: n })).timestamp);
  const lookback = BigInt(process.env.LAUNCH_EVENT_LOOKBACK_BLOCKS ?? "5000");
  const fromBlock = launchTimeBlock.blockNumber > lookback ? launchTimeBlock.blockNumber - lookback : 0n;
  const logs = await client.getLogs({ address: factory, event: launchCreated, args: { token: market.token }, fromBlock, toBlock: observation.blockNumber });
  if (logs.length !== 1) throw new Error(`Expected one canonical LaunchCreated event before observation; found ${logs.length}.`);
  const log = logs[0];
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.args.curve?.toLowerCase() !== market.curve.toLowerCase()) throw new Error("LaunchCreated event is incomplete or does not match the market curve.");
  const launchBlock = await client.getBlock({ blockNumber: log.blockNumber });
  if (launchBlock.hash.toLowerCase() !== log.blockHash.toLowerCase() || launchBlock.timestamp !== market.launchAt) throw new Error("LaunchCreated event is noncanonical or its timestamp differs from market launchAt.");
  const initializations = await client.getLogs({
    address: poolManager, event: v4Initialize, args: { id: poolId },
    fromBlock: log.blockNumber, toBlock: observation.blockNumber,
  });
  if (initializations.length > 1) throw new Error("More than one V4 Initialize event exists for this V6 pool key.");
  const initialization = initializations[0];
  if (initialization) {
    if (!curveComplete) throw new Error("V4 pool initialized while the V6 bonding curve is incomplete; refusing inconsistent evidence.");
    const initializedCurrency0 = initialization.args.currency0;
    const initializedCurrency1 = initialization.args.currency1;
    const initializedHooks = initialization.args.hooks;
    if (!initializedCurrency0 || !initializedCurrency1 || !initializedHooks
      || initializedCurrency0.toLowerCase() !== poolKey.currency0.toLowerCase()
      || initializedCurrency1.toLowerCase() !== poolKey.currency1.toLowerCase()
      || initialization.args.fee !== poolKey.fee
      || initialization.args.tickSpacing !== poolKey.tickSpacing
      || initializedHooks.toLowerCase() !== poolKey.hooks.toLowerCase()
      || initialization.args.sqrtPriceX96 === 0n) {
      throw new Error("V4 Initialize event does not match the V6 factory's pool key.");
    }
    const initializedBlock = await client.getBlock({ blockNumber: initialization.blockNumber! });
    if (initializedBlock.hash?.toLowerCase() !== initialization.blockHash?.toLowerCase()) throw new Error("V4 Initialize event is not on the canonical observation chain.");
  }
  const lockerLiquidityEvents = await client.getLogs({
    address: poolManager, event: v4ModifyLiquidity, args: { id: poolId, sender: locker },
    fromBlock: log.blockNumber, toBlock: observation.blockNumber,
  });
  for (const item of lockerLiquidityEvents) {
    const itemBlock = await client.getBlock({ blockNumber: item.blockNumber! });
    if (itemBlock.hash?.toLowerCase() !== item.blockHash?.toLowerCase()) throw new Error("V6 locker ModifyLiquidity event is not canonical.");
  }
  const lockerLiquidityAdded = lockerLiquidityEvents.reduce((sum, item) => sum + item.args.liquidityDelta!, 0n);
  const lockerLiquidityAddedInInitializationTx = Boolean(initialization && lockerLiquidityEvents.some(
    item => item.transactionHash?.toLowerCase() === initialization.transactionHash?.toLowerCase() && item.args.liquidityDelta! > 0n,
  ));
  if (initialization && !lockerLiquidityAddedInInitializationTx) {
    throw new Error("V4 pool initialization is not accompanied by a positive liquidity position from the V6 locker in the same transaction.");
  }
  const poolStateSlot = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }], [poolId, POOLS_SLOT],
  ));
  const liquiditySlot = `0x${(BigInt(poolStateSlot) + 3n).toString(16).padStart(64, "0")}` as Hex;
  const liquidityWord = await client.readContract({
    address: poolManager, abi: extSloadAbi, functionName: "extsload", args: [liquiditySlot], blockNumber: observation.blockNumber,
  });
  const activeLiquidity = BigInt(liquidityWord) & ((1n << 128n) - 1n);
  const outcomeYes = determineGraduationOutcome(curveComplete, Boolean(initialization), lockerLiquidityAdded, activeLiquidity);
  const observationBlock = await client.getBlock({ blockNumber: observation.blockNumber });
  if (!observationBlock.hash) throw new Error("Observation block has no canonical hash.");
  const evidence = {
    schema: "launchcast-graduation-evidence-v2", chainId: CHAIN_ID, marketId: marketId.toString(),
    token: market.token, curve: market.curve, factory, launchId: log.args.launchId?.toString(),
    launchAt: market.launchAt.toString(), launchBlock: log.blockNumber.toString(),
    launchBlockHash: log.blockHash, launchTransactionHash: log.transactionHash, launchLogIndex: log.logIndex,
    observationAt: market.observationAt.toString(), observationBlock: observation.blockNumber.toString(),
    observationTimestamp: observation.timestamp.toString(), observationBlockHash: observationBlock.hash,
    factoryIsV6AtObservation: isV6, factoryCurveAtObservation: mappedCurve,
    curveCompleteAtObservation: curveComplete, curvePairCurrency, poolManager, locker, poolId,
    poolKey: { currency0: poolKey.currency0, currency1: poolKey.currency1, fee: poolKey.fee.toString(), tickSpacing: poolKey.tickSpacing.toString(), hooks: poolKey.hooks },
    poolInitializedAtObservation: Boolean(initialization),
    lockerLiquidityAdded: lockerLiquidityAdded.toString(),
    lockerLiquidityAddedInInitializationTx,
    activeLiquidityAtObservation: activeLiquidity.toString(),
    lockerLiquidityEvents: lockerLiquidityEvents.map(item => ({
      blockNumber: item.blockNumber.toString(), blockHash: item.blockHash,
      transactionHash: item.transactionHash, logIndex: item.logIndex,
      sender: item.args.sender, tickLower: item.args.tickLower, tickUpper: item.args.tickUpper,
      liquidityDelta: item.args.liquidityDelta?.toString(), salt: item.args.salt,
    })),
    poolInitialization: initialization ? {
      blockNumber: initialization.blockNumber!.toString(), blockHash: initialization.blockHash,
      transactionHash: initialization.transactionHash, logIndex: initialization.logIndex,
      sqrtPriceX96: initialization.args.sqrtPriceX96!.toString(),
    } : null,
    outcomeYes,
    policy: { method: "canonical Uniswap V4 PoolManager Initialize event for the V6 locker pool key by observationAt; curve.complete() alone is not graduation", maxObservationLag: market.maxObservationLag.toString() },
  };
  const evidenceHash = keccak256(new TextEncoder().encode(JSON.stringify(evidence)));
  const domain = { name: "LaunchcastV2", version: "1", chainId: CHAIN_ID, verifyingContract: v2Address } as const;
  const types = { MarketAttestation: [
    { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    { name: "marketId", type: "uint256" }, { name: "outcome", type: "bool" },
    { name: "observationBlock", type: "uint64" }, { name: "observationTimestamp", type: "uint64" },
    { name: "observationBlockHash", type: "bytes32" }, { name: "evidenceHash", type: "bytes32" },
    { name: "fdvValue", type: "uint256" }, { name: "resolverVersion", type: "uint32" },
  ] } as const;
  const message = { chainId: BigInt(CHAIN_ID), verifyingContract: v2Address, marketId, outcome: outcomeYes,
    observationBlock: observation.blockNumber, observationTimestamp: observation.timestamp,
    observationBlockHash: observationBlock.hash, evidenceHash, fdvValue: 0n, resolverVersion: market.resolverVersion };
  const digest = hashTypedData({ domain, types, primaryType: "MarketAttestation", message });
  const privateKey = process.env.RESOLVER_PRIVATE_KEY as Hex | undefined;
  if (privateKey && process.env.SECONDARY_ARCHIVE_REPLAY === "1") {
    throw new Error("A secondary archive replay must never sign an attestation.");
  }
  if (privateKey) verifyOnSecondaryArchive("resolve-graduation", marketId.toString(), { evidenceHash, digest });
  let signer: Address | null = null;
  let signature: Hex | null = null;
  if (privateKey) {
    const signerAccount = privateKeyToAccount(privateKey);
    signer = signerAccount.address;
    if (!market.resolvers.some(address => address.toLowerCase() === signer!.toLowerCase())) throw new Error("Configured signer is not in this market's snapshotted resolver set.");
    signature = await signerAccount.signTypedData({ domain, types, primaryType: "MarketAttestation", message });
  }
  console.log(JSON.stringify({ status: signature ? "signed_evidence_ready" : "unsigned_evidence_ready",
    note: "A single signer output is not sufficient to submit the contract's 2-of-3 quorum. Collect a second independent resolver signature over this exact digest and sort signatures by recovered signer address.",
    signer, signature, evidenceHash, digest,
    attestation: { ...message, chainId: CHAIN_ID, marketId: marketId.toString(),
      observationBlock: observation.blockNumber.toString(), observationTimestamp: observation.timestamp.toString(), fdvValue: "0" },
    evidence }, null, 2));
}
main().catch(error => { console.error("Graduation resolver failed closed."); console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
