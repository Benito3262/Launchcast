import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.RPC_URL || process.env.VITE_ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com";
const CHAIN_ID = 46630;
const CONFIRMATION_BUFFER = 32n;
const DEFAULT_RECENT_WINDOW = 100_000n;
const INITIAL_CHUNK = 5_000n;
const REQUEST_DELAY_MS = 200;
const CACHE_PATH = resolve(ROOT, ".cache/vibevibe-discovery.json");
const OUTPUT_PATH = resolve(ROOT, "public/data/vibevibe-tokens.json");

const factories = [
  { generation: "retired", address: "0x4FEbC267e0C24440bcDEF72B5DBC5FE7BED091dF", deploymentBlock: 95_916_239n },
  { generation: "legacy", address: "0xB5B7A2f6c4EAFa2D73918fcA32d50e2126339eb9", deploymentBlock: 108_435_450n },
  { generation: "current", address: "0x40f1be6faf8DAB9C143cce1a0A04c2075Fb2DF59", deploymentBlock: 115_025_604n },
];

const launched = parseAbiItem("event TokenLaunched(uint256 indexed launchId,address indexed token,address indexed curve,address creator,address creatorFeeRecipient,address creatorVault,uint256 initialBuy,uint256 initialTokensBought,uint16 metadataSchemaVersion,bytes32 metadataDigest,string metadataURI)");
const launchedQuoted = parseAbiItem("event TokenLaunchedQuoted(uint256 indexed launchId,address indexed token,address indexed curve,address creator,address creatorFeeRecipient,address creatorVault,address quoteCurrency,uint256 initialBuy,uint256 initialTokensBought,uint16 metadataSchemaVersion,bytes32 metadataDigest,string metadataURI)");

const client = createPublicClient({ transport: http(RPC, { timeout: 30_000, retryCount: 0 }) });
const tokenReads = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function transfersUnlocked() view returns (bool)",
]);
const curveReads = parseAbi([
  "function graduated() view returns (bool)",
  "function complete() view returns (bool)",
]);
const factoryReads = parseAbi(["function launchCount() view returns (uint256)"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error) => String(error?.shortMessage || error?.message || error).toLowerCase();
const isRangeError = (error) => /timeout|timed out|too many|exceeds limit|limit exceeded|response size|block range|more than|query returned/i.test(errorText(error));

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function scanRange(factory, fromBlock, toBlock) {
  let size = INITIAL_CHUNK;
  let cursor = fromBlock;
  const found = [];
  while (cursor <= toBlock) {
    const end = cursor + size - 1n > toBlock ? toBlock : cursor + size - 1n;
    let logs;
    try {
      const [plain, quoted] = await Promise.all([
        client.getLogs({ address: factory.address, event: launched, fromBlock: cursor, toBlock: end }),
        client.getLogs({ address: factory.address, event: launchedQuoted, fromBlock: cursor, toBlock: end }),
      ]);
      logs = [...plain, ...quoted];
    } catch (error) {
      if (size > 1n && isRangeError(error)) {
        size = size / 2n || 1n;
        continue;
      }
      throw new Error("Log query failed for " + factory.generation + " blocks " + cursor + "-" + end + ": " + errorText(error));
    }
    for (const log of logs) {
      const args = log.args;
      found.push({
        chainId: CHAIN_ID,
        generation: factory.generation,
        factory: factory.address,
        launchId: args.launchId.toString(),
        token: args.token,
        curve: args.curve,
        creator: args.creator,
        creatorFeeRecipient: args.creatorFeeRecipient,
        creatorVault: args.creatorVault,
        quoteCurrency: args.quoteCurrency || null,
        initialBuy: args.initialBuy.toString(),
        initialTokensBought: args.initialTokensBought.toString(),
        metadataSchemaVersion: Number(args.metadataSchemaVersion),
        metadataDigest: args.metadataDigest,
        metadataURI: args.metadataURI,
        blockNumber: Number(log.blockNumber),
        transactionHash: log.transactionHash,
        logIndex: Number(log.logIndex),
      });
    }
    cursor = end + 1n;
    await sleep(REQUEST_DELAY_MS);
    if (size < INITIAL_CHUNK) size = size * 2n > INITIAL_CHUNK ? INITIAL_CHUNK : size * 2n;
  }
  return found;
}

async function main() {
  const actualChain = await client.getChainId();
  if (actualChain !== CHAIN_ID) throw new Error("Wrong RPC chain: expected 46630, received " + actualChain);
  const head = await client.getBlockNumber();
  const safeHead = head > CONFIRMATION_BUFFER ? head - CONFIRMATION_BUFFER : head;
  const fullHistory = process.argv.includes("--full-history");
  const cache = await readJson(CACHE_PATH, { schemaVersion: 1, lastScannedByFactory: {}, tokens: {} });
  if (cache.schemaVersion !== 1 || !cache.tokens || !cache.lastScannedByFactory) throw new Error("Discovery cache schema is not recognised. Move web/.cache/vibevibe-discovery.json aside and retry.");

  const factoryChecks = [];
  for (const factory of factories) {
    const code = await client.getCode({ address: factory.address });
    if (!code || code === "0x") throw new Error("Configured factory has no bytecode at " + factory.address + ". Stop and re-check the registry.");
    const launchCount = await client.readContract({ address: factory.address, abi: factoryReads, functionName: "launchCount" });
    factoryChecks.push({ generation: factory.generation, address: factory.address, bytecodePresent: true, onChainLaunchCount: launchCount.toString() });
    const key = factory.address.toLowerCase();
    const saved = cache.lastScannedByFactory[key];
    const defaultStart = fullHistory ? factory.deploymentBlock : (safeHead > DEFAULT_RECENT_WINDOW ? safeHead - DEFAULT_RECENT_WINDOW : factory.deploymentBlock);
    const from = fullHistory ? factory.deploymentBlock : (saved === undefined ? defaultStart : (BigInt(saved) > factory.deploymentBlock ? BigInt(saved) - CONFIRMATION_BUFFER : factory.deploymentBlock));
    if (from > safeHead) continue;
    console.log("Scanning " + factory.generation + " from " + from + " to " + safeHead + (fullHistory ? " (full-history request)" : ""));
    const logs = await scanRange(factory, from, safeHead);
    for (const token of logs) {
      const keyToken = token.token.toLowerCase();
      const previous = cache.tokens[keyToken];
      if (!previous || token.blockNumber < previous.blockNumber) cache.tokens[keyToken] = token;
    }
    cache.lastScannedByFactory[key] = safeHead.toString();
    cache.lastRun = { chainId: CHAIN_ID, headBlock: head.toString(), safeHead: safeHead.toString(), updatedAt: new Date().toISOString() };
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
    console.log("  found " + logs.length + " launch events; registry now has " + Object.keys(cache.tokens).length + " unique token addresses");
  }

  const tokens = Object.values(cache.tokens).sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  // Enrich only the newest 50 launches. These are current-state reads, not historical snapshots.
  for (const token of tokens.slice(0, 50)) {
    const [name, symbol, decimals, transfersUnlocked, graduated, complete] = await Promise.all([
      client.readContract({ address: token.token, abi: tokenReads, functionName: "name" }).catch(() => null),
      client.readContract({ address: token.token, abi: tokenReads, functionName: "symbol" }).catch(() => null),
      client.readContract({ address: token.token, abi: tokenReads, functionName: "decimals" }).catch(() => null),
      client.readContract({ address: token.token, abi: tokenReads, functionName: "transfersUnlocked" }).catch(() => null),
      client.readContract({ address: token.curve, abi: curveReads, functionName: "graduated" }).catch(() => null),
      client.readContract({ address: token.curve, abi: curveReads, functionName: "complete" }).catch(() => null),
    ]);
    Object.assign(token, {
      name, symbol, decimals: decimals === null ? null : Number(decimals),
      transfersUnlocked, graduated, complete, stateReadAtBlock: safeHead.toString(),
    });
    await sleep(100);
  }
  const output = {
    schemaVersion: 1,
    chainId: CHAIN_ID,
    source: "Robinhood Chain Testnet factory event logs",
    generatedAt: new Date().toISOString(),
    headBlock: head.toString(),
    safeHeadBlock: safeHead.toString(),
    coverage: fullHistory ? "configured_factories_full_history" : "configured_factories_recent_window",
    warning: "This is not a canonical factory registry. Three known factory generations are scanned; unknown or newly deployed factories may be missing. Token/curve state fields are current-state reads at stateReadAtBlock, not historical values. Never use this file to decide market outcomes.",
    factories: factories.map((f) => ({ ...factoryChecks.find((check) => check.address.toLowerCase() === f.address.toLowerCase()), deploymentBlock: f.deploymentBlock.toString(), lastScannedBlock: cache.lastScannedByFactory[f.address.toLowerCase()] || null })),
    totalTokens: tokens.length,
    tokens,
  };
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log("Wrote " + OUTPUT_PATH + " with " + tokens.length + " token records.");
  console.log(fullHistory ? "Full history requested; RPC limits may make this a long run." : "Recent-window scan complete. Run --full-history for historical reconstruction.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
