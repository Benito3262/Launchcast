export type BlockTimestampReader = (blockNumber: bigint) => Promise<bigint>;

export type ObservationBlock = {
  blockNumber: bigint;
  timestamp: bigint;
};

/**
 * Selects the final block whose timestamp is less than or equal to the target.
 * If multiple blocks share the target second, the highest block number wins.
 */
export async function findBlockAtOrBeforeTimestamp(
  latestBlock: bigint,
  targetTimestamp: bigint,
  readTimestamp: BlockTimestampReader,
): Promise<ObservationBlock> {
  if (latestBlock < 0n) throw new RangeError("Latest block cannot be negative.");
  if (targetTimestamp < 0n) throw new RangeError("Target timestamp cannot be negative.");

  const cache = new Map<bigint, bigint>();
  const timestampAt = async (blockNumber: bigint) => {
    const cached = cache.get(blockNumber);
    if (cached !== undefined) return cached;
    const timestamp = await readTimestamp(blockNumber);
    if (timestamp < 0n) throw new RangeError("Block timestamp cannot be negative.");
    cache.set(blockNumber, timestamp);
    return timestamp;
  };

  const genesisTimestamp = await timestampAt(0n);
  if (targetTimestamp < genesisTimestamp) {
    throw new RangeError("Target timestamp is earlier than the chain genesis block.");
  }

  const latestTimestamp = await timestampAt(latestBlock);
  if (targetTimestamp > latestTimestamp) {
    throw new RangeError("Target timestamp is later than the latest block.");
  }

  let low = 0n;
  let high = latestBlock;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    const middleTimestamp = await timestampAt(middle);
    if (middleTimestamp <= targetTimestamp) low = middle;
    else high = middle - 1n;
  }

  return { blockNumber: low, timestamp: await timestampAt(low) };
}

export type V4PriceEventCandidate = {
  source: "swap" | "initialize";
  blockNumber: bigint;
  logIndex: number;
  sqrtPriceX96: bigint;
  liquidity?: bigint;
  transactionHash?: string;
};

export function selectLatestV4PriceEvent(
  events: V4PriceEventCandidate[],
  targetBlock: bigint,
): V4PriceEventCandidate | null {
  const eligible = events.filter(event => event.blockNumber <= targetBlock);
  eligible.sort((a, b) => {
    if (a.blockNumber < b.blockNumber) return -1;
    if (a.blockNumber > b.blockNumber) return 1;
    return a.logIndex - b.logIndex;
  });
  return eligible.at(-1) ?? null;
}


export type FdvEligibilityInput = {
  pricePairScaled1e18: bigint;
  totalSupplyAtObservation: bigint | null;
  priceEventAgeSeconds: bigint;
  maxStalenessSeconds: bigint;
};

export type FdvEligibility = { eligible: boolean; reasons: string[] };

/** A diagnostic gate only; this does not authorize or settle an on-chain market. */
export function evaluateFdvEligibility(input: FdvEligibilityInput): FdvEligibility {
  const reasons: string[] = [];
  if (input.pricePairScaled1e18 <= 0n) reasons.push("non_positive_price");
  if (input.totalSupplyAtObservation === null) reasons.push("historical_supply_unavailable");
  else if (input.totalSupplyAtObservation <= 0n) reasons.push("non_positive_historical_supply");
  if (input.priceEventAgeSeconds < 0n) reasons.push("price_event_after_observation");
  if (input.maxStalenessSeconds < 0n || input.priceEventAgeSeconds > input.maxStalenessSeconds) {
    reasons.push("stale_price_event");
  }
  return { eligible: reasons.length === 0, reasons };
}


export type SupplyTransferEvent = {
  from: string;
  to: string;
  value: bigint;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
  blockHash: string;
};

export type ReconstructedSupply = {
  totalSupply: bigint;
  mintCount: number;
  burnCount: number;
  transferCount: number;
};

/**
 * Reconstructs ERC-20 totalSupply from standard Transfer mint/burn events.
 * The caller MUST independently prove complete coverage from factory creation
 * through the requested observation block. This helper cannot prove log completeness.
 */
export function reconstructSupplyFromTransferEvents(
  events: SupplyTransferEvent[],
  observationBlock: bigint,
): ReconstructedSupply {
  if (observationBlock < 0n) throw new RangeError("Observation block cannot be negative.");
  const zero = "0x0000000000000000000000000000000000000000";
  const eligible = events.filter(event => event.blockNumber <= observationBlock);
  eligible.sort((a, b) => {
    if (a.blockNumber < b.blockNumber) return -1;
    if (a.blockNumber > b.blockNumber) return 1;
    return a.logIndex - b.logIndex;
  });

  let totalSupply = 0n;
  let mintCount = 0;
  let burnCount = 0;
  for (const event of eligible) {
    if (event.value < 0n) throw new RangeError("Transfer value cannot be negative.");
    if (event.from.toLowerCase() === zero) {
      totalSupply += event.value;
      mintCount++;
    }
    if (event.to.toLowerCase() === zero) {
      totalSupply -= event.value;
      burnCount++;
    }
    if (totalSupply < 0n) throw new RangeError("Reconstructed supply became negative.");
  }
  return { totalSupply, mintCount, burnCount, transferCount: eligible.length };
}

/** Rejects any missing, overlapping, reversed, or out-of-order log-scan interval. */
export function assertCompleteBlockCoverage(
  ranges: Array<{ fromBlock: bigint; toBlock: bigint }>,
  expectedFrom: bigint,
  expectedTo: bigint,
): void {
  if (expectedFrom < 0n || expectedTo < expectedFrom) {
    throw new RangeError("Expected scan range is invalid.");
  }
  let next = expectedFrom;
  for (const range of ranges) {
    if (range.fromBlock !== next || range.toBlock < range.fromBlock) {
      throw new Error("Log scan coverage contains a gap, overlap, or invalid range.");
    }
    next = range.toBlock + 1n;
  }
  if (next !== expectedTo + 1n) {
    throw new Error("Log scan coverage does not reach the requested final block.");
  }
}
