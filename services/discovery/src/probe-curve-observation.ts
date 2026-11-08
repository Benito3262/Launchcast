import { createPublicClient, http, parseAbi, type Address } from "viem";
import { DEFAULT_RPC, CHAIN_ID } from "./config.js";
import { findBlockAtOrBeforeTimestamp } from "./observation.js";

const [targetArg, curveArg] = process.argv.slice(2);
if (!targetArg || !curveArg) {
  throw new Error("Usage: npm run probe:curve-observation -- <target-unix-timestamp> <curve-address> [pair-input-base-units]");
}

const targetTimestamp = BigInt(targetArg);
const curve = curveArg as Address;
const pairInput = BigInt(process.argv[4] ?? "1000000000000000");
const rpcUrl = process.env.RPC_URL || DEFAULT_RPC;
const client = createPublicClient({
  transport: http(rpcUrl, {
    timeout: 30_000,
    retryCount: 0,
    fetchOptions: { headers: { "user-agent": "Mozilla/5.0 (compatible; LaunchcastDiscovery/0.1)" } },
  }),
});
const abi = parseAbi([
  "function complete() view returns (bool)",
  "function pairCurrency() view returns (address)",
  "function quoteBuyExactIn(uint256 pairIn) view returns (uint256 gross, uint256 net, uint256 cost, uint256 pairFee, uint256 refund)",
]);

async function main() {
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`Wrong chain: expected ${CHAIN_ID}, received ${chainId}.`);

  const latestBlock = await client.getBlockNumber();
  const observation = await findBlockAtOrBeforeTimestamp(
    latestBlock,
    targetTimestamp,
    async blockNumber => (await client.getBlock({ blockNumber })).timestamp,
  );

  const [complete, pairCurrency] = await Promise.all([
    client.readContract({ address: curve, abi, functionName: "complete", blockNumber: observation.blockNumber }),
    client.readContract({ address: curve, abi, functionName: "pairCurrency", blockNumber: observation.blockNumber }),
  ]);
  if (complete) throw new Error("Curve was already complete at the observation block; use the V4 pool observation path.");

  const quote = await client.readContract({
    address: curve, abi, functionName: "quoteBuyExactIn",
    args: [pairInput], blockNumber: observation.blockNumber,
  });

  console.log(JSON.stringify({
    chainId,
    curve,
    targetTimestamp: targetTimestamp.toString(),
    observationBlock: observation.blockNumber.toString(),
    observationBlockTimestamp: observation.timestamp.toString(),
    secondsBeforeTarget: (targetTimestamp - observation.timestamp).toString(),
    pairCurrency,
    pairInput: pairInput.toString(),
    quote: {
      grossTokensOut: quote[0].toString(),
      netTokensOut: quote[1].toString(),
      pairCost: quote[2].toString(),
      pairFee: quote[3].toString(),
      refund: quote[4].toString(),
    },
    warning: "Historical state read only. This probe does not create a market, attest a price, or settle a result.",
  }, null, 2));
}

main().catch(error => {
  console.error("Historical curve observation failed.");
  console.error(error instanceof Error ? error.message : String(error));
  if (String(error).toLowerCase().includes("historical state")) {
    console.error("This RPC does not provide the historical state needed for a 12h/24h curve observation. Configure an archive-capable RPC_URL.");
  }
  process.exitCode = 1;
});
