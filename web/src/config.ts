import { createPublicClient, defineChain, http, type Address } from "viem";

export const RPC = import.meta.env.VITE_ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com";
export const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
export const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Robinhood Testnet ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "Robinhood Explorer", url: EXPLORER } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});
// readContract calls made in the same tick are folded into one Multicall3 eth_call, and JSON-RPC batches are capped,
// so a connected wallet with many positions doesn't trip the public RPC's rate limit (which answers without CORS headers).
export const publicClient = createPublicClient({
  chain,
  batch: { multicall: { wait: 25, batchSize: 2048 } },
  transport: http(RPC, { batch: { batchSize: 25, wait: 25 }, retryCount: 4, retryDelay: 400 }),
});

/** LaunchCast V2, deployed 9 Nov 2026 by the LaunchCast owner wallet (GitHub Actions run 42657812701). */
export const V2_ADDRESS = (import.meta.env.VITE_LAUNCHCAST_V2_ADDRESS || "0x6c03417bb306110f4cbd560a80e0784b7d82e023") as Address;
/** LaunchcastFdv: FDV markets on any V6 launch, settled from on-chain curve/pool state (deployed 12 Nov 2026). */
export const FDV_ADDRESS = "0xda8051febc52f8cbf712c44a04a8d581c5d892e1" as Address;
export const STAKE_TOKEN = "0x9557aade5c89fe39941b4f3a60cbac16e3f32143" as Address;
export const OWNER = "0x54032f2d6aDc9b327F5f2222D5AE1d6346a2Cb14" as Address;
export const V6_FACTORY = "0xac135da186de8325047ef2afd1d16d5971f731f7" as Address;
export const REPO = "https://github.com/Benito3262/Launchcast";
export const ETH_FAUCET = "https://faucet.testnet.chain.robinhood.com/";
export const VIBEVIBE = "https://testnet.vibevibe.fun/";
export const addr = (a: string) => `${EXPLORER}/address/${a}`;
export const short = (s?: string) => (s ? s.slice(0, 6) + "…" + s.slice(-4) : "—");
