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
 ¶»§q«^