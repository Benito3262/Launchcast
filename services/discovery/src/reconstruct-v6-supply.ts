import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Log,
} from "viem";
import { DEFAULT_RPC } from "./config.js";
import {
  assertCompleteBlockCoverage,
  reconstructSupplyFromTransferEvents,
  type SupplyTransferEvent,
} from "./observation.js";

const FACTORY = "0xac135da186de8325047ef2afd1d16d5971f731f7" as Address;
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
type RawTransfer = Log<bigint, 