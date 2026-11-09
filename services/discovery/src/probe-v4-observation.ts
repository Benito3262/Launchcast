import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { assertV6FactoryCode, CHAIN_ID, DEFAULT_RPC, V6_FACTORY_ADDRESS } from "./config.js";
import { evaluateFdvEligibility, findBlockAtOrBeforeTimestamp, selectLatestV4PriceEvent, type V4PriceEventCandidate } from "./observation.js";
import { fdvPairScaled1e18, sqrtPriceFromPoolStateWord, v4PriceScaled1e18 } from "./v6-helpers.js";

const [targetArg, tokenArg, maxStalenessArg] = process.argv.slice(2);
if (!targetArg || !tokenArg) {
  throw new Error("Usage: npm run probe:v4-observation -- <target-unix-timestamp> <token-address> [max-staleness-seconds]");
}
const targetTimestamp = BigInt(targetArg);
const token = tokenArg as Address;
const maxStalenessSeconds = BigInt(maxStalenessArg ?? "3600");
const rpcUrl = process.env.ARCHIVE_RPC_URL || process.env.RPC_URL || DEFAULT_RPC;
const client = createPublicClient({
  transport: http(rpcUrl, {
    timeout: 30_000,
    retryCount: 0,
    fetchOptions: { headers: { "user-agent": "Mozilla/5.0 (compatible; LaunchcastDiscovery/0.1)" } },
  }),
});

const factory = V6_FACTORY_ADDRESS;
const factoryReads = parseAbi([
  "function isV6Token(address token) view returns (bool)",
  "function curveOf(address token) view returns (address)",
  "function locker() view returns (address)",
  "function poolManager() view returns (address)",
  "function hook() view returns (address)",
]);
const tokenReads = parseAbi([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
const curveReads = parseAbi([
  "function createdAt() view returns (uint256)",
  "function complete() view returns (bool)",
  "function pairCurrency() view returns (address)",
]);
const pairReads = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const lockerReads = parseAbi([
  "function poolKeyOf(address token) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))",
]);
const swapEvent = parseAbiItem("event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)");
const initializeEvent = parseAbiItem("event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)");
const modifyLiquidityEvent = parseAbiItem("event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)");

async function main() {
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`Wrong chain: expected ${CHAIN_ID}, received ${chainId}.`);
  await assertV6FactoryCode(client);
  const head = await client.getBlockNumber();
  // Resolve the historical observation block first, then read all factory, curve,
  // token and pool metadata at that same block. Current-head metadata must not
  // leak into a historical FDV snapshot.
  const observation = await findBlockAtOrBeforeTimestamp(
    head,
    targetTimestamp,
    async blockNumber => (await client.getBlock({ blockNumber })).timestamp,
  );
  const historicalBlock = observation.blockNumber;
  const [isV6, curve, locker, poolManager, hook] = await Promise.all([
    client.readContract({ address: factory, abi: factoryReads, functionName: "isV6Token", args: [token], blockNumber: historicalBlock }),
    client.readContract({ address: factory, abi: factoryReads, functionName: "curveOf", args: [token], blockNumber: historicalBlock }),
    client.readContract({ address: factory, abi: factoryReads, functionName: "locker", blockNumber: historicalBlock }),
    client.readContract({ address: factory, abi: factoryReads, functionName: "poolManager", blockNumber: historicalBlock }),
    client.readContract({ address: factory, abi: factoryReads, functionName: "hook", blockNumber: historicalBlock }),
  ]);
  if (!isV6) throw new Error("Token was not recognised by the V6 factory at the observation block.");
  const [createdAt, complete, pairCurrency, tokenDecimals] = await Promise.all([
    client.readContract({ address: curve, abi: curveReads, functionName: "createdAt", blockNumber: historicalBlock }),
    client.readContract({ address: curve, abi: curveReads, functionName: "complete", blockNumber: historicalBlock }),
    client.readContract({ address: curve, abi: curveReads, functionName: "pairCurrency", blockNumber: historicalBlock }),
    client.readContract({ address: token, abi: tokenReads, functionName: "decimals", blockNumber: historicalBlock }),
  ]);
  if (!complete) throw new Error("Token has not completed its curve; this probe only supports graduated V4 pools.");

  let pairDecimals = 18;
  let pairSymbol = "ETH";
  if (pairCurrency !== "0x0000000000000000000000000000000000000000") {
    const [decimals, symbol] = await Promise.all([
      client.readContract({ address: pairCurrency, abi: pairReads, functionName: "decimals", blockNumber: historicalBlock }),
      client.readContract({ address: pairCurrency, abi: pairReads, functionName: "symbol", blockNumber: historicalBlock }),
    ]);
    pairDecimals = Number(decimals);
    pairSymbol = symbol;
  }

  const key = await client.readContract({ address: locker, abi: lockerReads, functionName: "poolKeyOf", args: [token], blockNumber: historicalBlock });
  const tokenIsCurrency0 = key.currency0.toLowerCase() === token.toLowerCase();
  const tokenIsCurrency1 = key.currency1.toLowerCase() === token.toLowerCase();
  const otherCurrency = tokenIsCurrency0 ? key.currency1 : key.currency0;
  if ((!tokenIsCurrency0 && !tokenIsCurrency1)
    || otherCurrency.toLowerCase() !== pairCurrency.toLowerCase()
    || key.hooks.toLowerCase() !== hook.toLowerCase()) {
    throw new Error("V4 pool key does not match the token, pair currency, or active factory hook.");
  }

  const poolId = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
  const createdBlock = await findBlockAtOrBeforeTimestamp(
    head,
    createdAt,
    async blockNumber => (await client.getBlock({ blockNumber })).timestamp,
  );
  if (createdBlock.blockNumber > observation.blockNumber) {
    throw new Error("Token did not exist at the target observation time.");
  }

  const [swaps, initializations, lockerLiquidityEvents] = await Promise.all([
    client.getLogs({ address: poolManager, event: swapEvent, args: { id: poolId }, fromBlock: createdBlock.blockNumber, toBlock: observation.blockNumber }),
    client.getLogs({ address: poolManager, event: initializeEvent, args: { id: poolId }, fromBlock: createdBlock.blockNumber, toBlock: observation.blockNumber }),
    client.getLogs({ address: poolManager, event: modifyLiquidityEvent, args: { id: poolId, sender: locker }, fromBlock: createdBlock.blockNumber, toBlock: observation.blockNumber }),
  ]);
  if (initializations.length !== 1) throw new Error("V6 pool must have exactly one canonical V4 Initialize event by the FDV observation block.");
  const initialization = initializations[0];
  const lockerLiquidityAdded = lockerLiquidityEvents.reduce((sum, item) => sum + item.args.liquidityDelta!, 0n);
  const lockerLiquidityAddedInInitializationTx = lockerLiquidityEvents.some(
    item => item.transactionHash?.toLowerCase() === initialization.transactionHash?.toLowerCase() && item.args.liquidityDelta! > 0n,
  );
  if (!lockerLiquidityAddedInInitializationTx || lockerLiquidityAdded <= 0n) {
    throw new Error("FDV pool is missing the V6 locker's positive liquidity addition in the initialization transaction.");
  }
  const candidates: V4PriceEventCandidate[] = [
    ...initializations.map(log => ({
      source: "initialize" as const,
      blockNumber: log.blockNumber!,
      logIndex: log.logIndex!,
      sqrtPriceX96: log.args.sqrtPriceX96!,
      transactionHash: log.transactionHash,
    })),
    ...swaps.map(log => ({
      source: "swap" as const,
      blockNumber: log.blockNumber!,
      logIndex: log.logIndex!,
      sqrtPriceX96: log.args.sqrtPriceX96!,
      liquidity: log.args.liquidity,
      transactionHash: log.transactionHash,
    })),
  ];
  const selected = selectLatestV4PriceEvent(candidates, observation.blockNumber);
  if (!selected) throw new Error("No V4 initialization or swap event exists at or before the target time.");

  const eventBlock = await client.getBlock({ blockNumber: selected.blockNumber });
  const ageSeconds = observation.timestamp - eventBlock.timestamp;
  const price = v4PriceScaled1e18(selected.sqrtPriceX96, tokenIsCurrency0, Number(tokenDecimals), pairDecimals);
  let totalSupplyAtObservation: bigint | null = null;
  let fdv: bigint | null = null;
  let supplyStatus = "historical_supply_unavailable";
  try {
    totalSupplyAtObservation = await client.readContract({
      address: token, abi: tokenReads, functionName: "totalSupply", blockNumber: observation.blockNumber,
    });
    fdv = fdvPairScaled1e18(price, totalSupplyAtObservation, Number(tokenDecimals));
    supplyStatus = "historical_supply_read";
  } catch {
    // Do not substitute current supply into a historical FDV calculation.
  }
  const fdvEligibility = evaluateFdvEligibility({
    pricePairScaled1e18: price,
    totalSupplyAtObservation,
    priceEventAgeSeconds: ageSeconds,
    maxStalenessSeconds,
  });
  const observationBlock = await client.getBlock({ blockNumber: observation.blockNumber });
  const poolStateSlot = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n],
  ));
  const liquiditySlot = `0x${(BigInt(poolStateSlot) + 3n).toString(16).padStart(64, "0")}` as Hex;
  const stateAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
  const [observationStateWord, observationLiquidityWord] = await Promise.all([
    client.readContract({ address: poolManager, abi: stateAbi, functionName: "extsload", args: [poolStateSlot], blockNumber: observation.blockNumber }),
    client.readContract({ address: poolManager, abi: stateAbi, functionName: "extsload", args: [liquiditySlot], blockNumber: observation.blockNumber }),
  ]);
  const sqrtPriceAtObservation = sqrtPriceFromPoolStateWord(observationStateWord);
  const activeLiquidityAtObservation = BigInt(observationLiquidityWord) & ((1n << 128n) - 1n);
  if (sqrtPriceAtObservation <= 0n || activeLiquidityAtObservation <= 0n) {
    throw new Error("V6 pool has no active price/liquidity state at the FDV observation block.");
  }
  let liveStateSqrtPrice: string | null = null;
  try {
    const word = await client.readContract({ address: poolManager, abi: stateAbi, functionName: "extsload", args: [poolStateSlot], blockNumber: head });
    liveStateSqrtPrice = sqrtPriceFromPoolStateWord(word).toString();
  } catch {
    // Historical observation state is mandatory; the optional latest-state diagnostic may be unavailable.
  }

  console.log(JSON.stringify({
    chainId, token, curve, pairCurrency, pairSymbol, pairDecimals,
    targetTimestamp: targetTimestamp.toString(),
    observationBlock: observation.blockNumber.toString(),
    observationBlockTimestamp: observation.timestamp.toString(),
    observationBlockHash: observationBlock.hash,
    poolId,
    poolInitializedAtObservation: true,
    lockerLiquidityAdded: lockerLiquidityAdded.toString(),
    lockerLiquidityAddedInInitializationTx,
    activeLiquidityAtObservation: activeLiquidityAtObservation.toString(),
    sourceEvent: selected.source,
    sourceEventBlock: selected.blockNumber.toString(),
    sourceEventTimestamp: eventBlock.timestamp.toString(),
    sourceEventBlockHash: eventBlock.hash,
    sourceEventLogIndex: selected.logIndex,
    sourceEventTransaction: selected.transactionHash,
    secondsSinceLastPriceEventAtTarget: ageSeconds.toString(),
    maxStalenessSeconds: maxStalenessSeconds.toString(),
    status: ageSeconds <= maxStalenessSeconds ? "fresh" : "stale",
    fdvEligibility,
    sqrtPriceX96: selected.sqrtPriceX96.toString(),
    liveStateSqrtPrice,
    matchesCurrentPoolState: liveStateSqrtPrice === null ? null : liveStateSqrtPrice === selected.sqrtPriceX96.toString(),
    pricePairPerTokenScaled1e18: price.toString(),
    totalSupplyAtObservation: totalSupplyAtObservation?.toString() ?? null,
    supplyStatus,
    fdvPairScaled1e18: fdv?.toString() ?? null,
    warning: "Event-derived V4 spot snapshot only. FDV is omitted unless totalSupply is readable at the historical observation block. This does not provide USD conversion, liquidity guarantees, an oracle attestation, or market settlement.",
  }, null, 2));
}

main().catch(error => {
  console.error("V4 historical observation probe failed.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
