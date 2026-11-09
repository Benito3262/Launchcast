import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Log,
} from "viem";
import { assertV6FactoryCode, DEFAULT_RPC, V6_FACTORY_ADDRESS } from "./config.js";
import {
  assertCompleteBlockCoverage,
  reconstructSupplyFromTransferEvents,
  type SupplyTransferEvent,
} from "./observation.js";

const FACTORY = V6_FACTORY_ADDRESS;
const FACTORY_CHUNK_BLOCKS = 9_000_000n;
const TOKEN_CHUNK_BLOCKS = 5_000n;
const rpcUrl = process.env.RPC_URL || DEFAULT_RPC;
const client = createPublicClient({
  transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }),
});

const launchEvent = parseAbiItem(
  "event LaunchCreated(uint256 indexed launchId,address indexed launcher,address indexed token,address curve,string name,string symbol,string metadataURI,address pairCurrency,uint16 taxBps,uint64 packedWeights,address projectTreasury,uint256 targetPairUnits,uint256 netPersonal,uint256 giftNetTotal,bytes32 giftRoot,uint256 giftCount)",
);
const factoryAbi = parseAbi([
  "function isV6Token(address token) view returns (bool)",
  "function tokenOfLaunch(uint256 launchId) view returns (address)",
]);
const tokenAbi = parseAbi(["function totalSupply() view returns (uint256)"]);
const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");

type Range = { fromBlock: bigint; toBlock: bigint };
type RawTransfer = Log<bigint, number, false, typeof transferEvent>;

function asAddress(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Token must be a 20-byte hex address.");
  return value as Address;
}

async function scanRanges<T>(
  address: Address,
  event: any,
  fromBlock: bigint,
  toBlock: bigint,
  chunkBlocks: bigint,
): Promise<{ logs: T[]; ranges: Range[] }> {
  const logs: T[] = [];
  const ranges: Range[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
    const end = start + chunkBlocks - 1n > toBlock ? toBlock : start + chunkBlocks - 1n;
    // Each successful getLogs response accounts for this exact, contiguous interval.
    const batch = await client.getLogs({
      address,
      event,
      fromBlock: start,
      toBlock: end,
    });
    for (const log of batch) {
      if (log.removed) throw new Error("RPC returned a removed log; refusing a reorg-ambiguous scan.");
      if (!log.blockHash || !log.transactionHash || log.logIndex === null) {
        throw new Error("RPC returned a log without canonical identity fields.");
      }
    }
    logs.push(...batch as T[]);
    ranges.push({ fromBlock: start, toBlock: end });
  }
  assertCompleteBlockCoverage(ranges, fromBlock, toBlock);
  return { logs, ranges };
}

async function main() {
  const [tokenArg, targetArg] = process.argv.slice(2);
  if (!tokenArg) throw new Error("Usage: npm run reconstruct:v6-supply -- <token-address> [observation-block]");
  const token = asAddress(tokenArg);
  const chainId = await client.getChainId();
  if (chainId !== 46630) throw new Error(`Unexpected chain ID ${chainId}; expected Robinhood testnet 46630.`);

  const head = await client.getBlockNumber();
  const target = targetArg ? BigInt(targetArg) : head;
  if (target < 0n || target > head) throw new Error("Observation block must be between genesis and current head.");
  const headBlockBefore = await client.getBlock({ blockNumber: head });
  const observationBlock = await client.getBlock({ blockNumber: target });

  // Scan from genesis so the factory creation block does not depend on historical eth_getCode support.
  const factoryHistory = await scanRanges<Log<bigint, number, false, typeof launchEvent>>(
    FACTORY, launchEvent, 0n, head, FACTORY_CHUNK_BLOCKS,
  );
  const matchingLaunches = factoryHistory.logs.filter(log => log.args.token?.toLowerCase() === token.toLowerCase());
  if (matchingLaunches.length !== 1) {
    throw new Error(`Expected exactly one active-factory LaunchCreated event for token; found ${matchingLaunches.length}.`);
  }
  const launch = matchingLaunches[0]!;
  if (launch.blockNumber === null || launch.blockNumber === undefined) throw new Error("Launch event has no block number.");
  const creationBlock = launch.blockNumber;
  if (creationBlock > target) throw new Error("Token was created after the requested observation block.");

  const [isV6, mappedToken] = await Promise.all([
    client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "isV6Token", args: [token], blockNumber: head }),
    client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "tokenOfLaunch", args: [launch.args.launchId!], blockNumber: head }),
  ]);
  if (!isV6 || mappedToken.toLowerCase() !== token.toLowerCase()) {
    throw new Error("Factory launch event does not match current V6 factory mappings.");
  }

  const transferHistory = await scanRanges<RawTransfer>(token, transferEvent, creationBlock, head, TOKEN_CHUNK_BLOCKS);
  const transferEvents: SupplyTransferEvent[] = transferHistory.logs.map(log => ({
    from: log.args.from!,
    to: log.args.to!,
    value: log.args.value!,
    blockNumber: log.blockNumber!,
    logIndex: log.logIndex!,
    transactionHash: log.transactionHash!,
    blockHash: log.blockHash!,
  }));

  const transferBlockHashes = [...new Set(transferHistory.logs.map(log => log.blockNumber!.toString()))];
  const canonicalTransferBlocks = await Promise.all(transferBlockHashes.map(async block => ({
    block,
    hash: (await client.getBlock({ blockNumber: BigInt(block) })).hash,
  })));
  const canonicalHashByBlock = new Map(canonicalTransferBlocks.map(item => [item.block, item.hash]));
  for (const log of transferHistory.logs) {
    if (canonicalHashByBlock.get(log.blockNumber!.toString()) !== log.blockHash) {
      throw new Error(`Transfer log block hash mismatch at block ${log.blockNumber}.`);
    }
  }

  const atObservation = reconstructSupplyFromTransferEvents(transferEvents, target);
  const atHead = reconstructSupplyFromTransferEvents(transferEvents, head);
  const liveSupply = await client.readContract({
    address: token, abi: tokenAbi, functionName: "totalSupply", blockNumber: head,
  });
  if (atHead.totalSupply !== liveSupply) {
    throw new Error(`Reconstructed head supply ${atHead.totalSupply} does not match live totalSupply() ${liveSupply}.`);
  }

  const headBlockAfter = await client.getBlock({ blockNumber: head });
  if (headBlockBefore.hash !== headBlockAfter.hash) {
    throw new Error("Selected head block changed during scan; retry after chain stabilizes.");
  }
  if (!launch.blockHash) throw new Error("Factory launch event is missing its block hash.");
  const launchBlock = await client.getBlock({ blockNumber: creationBlock });
  if (launch.blockHash !== launchBlock.hash) throw new Error("Factory launch event block hash does not match canonical block.");

  console.log(JSON.stringify({
    mode: "research_only_event_reconstruction",
    settlementAuthority: false,
    chainId,
    factory: FACTORY,
    token,
    launchId: launch.args.launchId!.toString(),
    launchTransactionHash: launch.transactionHash,
    creationBlock: creationBlock.toString(),
    creationBlockHash: launchBlock.hash,
    observationBlock: target.toString(),
    observationBlockHash: observationBlock.hash,
    headBlock: head.toString(),
    headBlockHash: headBlockBefore.hash,
    factoryLogCoverage: factoryHistory.ranges.map(r => ({ from: r.fromBlock.toString(), to: r.toBlock.toString() })),
    transferLogCoverage: transferHistory.ranges.map(r => ({ from: r.fromBlock.toString(), to: r.toBlock.toString() })),
    transferEventEvidence: transferHistory.logs.map(log => ({
      blockNumber: log.blockNumber!.toString(),
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      from: log.args.from,
      to: log.args.to,
      value: log.args.value!.toString(),
    })),
    observationSupply: atObservation.totalSupply.toString(),
    observationMintCount: atObservation.mintCount,
    observationBurnCount: atObservation.burnCount,
    observationTransferCount: atObservation.transferCount,
    headReconstructedSupply: atHead.totalSupply.toString(),
    headLiveTotalSupply: liveSupply.toString(),
    headSupplyMatches: atHead.totalSupply === liveSupply,
    caveat: "Complete RPC log-range responses and head totalSupply agreement are evidence, not proof that unverified token code emits Transfer for every supply mutation. Do not use for settlement.",
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
