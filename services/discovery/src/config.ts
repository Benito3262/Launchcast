import { keccak256, type Address, type Hex } from "viem";

export const CHAIN_ID = 46630;
export const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";

export const V6_FACTORY_ADDRESS = "0xac135da186de8325047ef2afd1d16d5971f731f7" as Address;
export const V6_FACTORY_DEPLOYMENT_BLOCK = 149_342_691n;
export const V6_FACTORY_RUNTIME_CODE_HASH = "0xd976b25d1c3cd3e5ea73984d0e400fa2678463d16e59e017c5ab51be40cdd83e" as Hex;

type FactoryCodeReader = { getCode(args: { address: Address }): Promise<Hex | undefined> };

export async function assertV6FactoryCode(client: FactoryCodeReader): Promise<void> {
  const code = await client.getCode({ address: V6_FACTORY_ADDRESS });
  if (!code || keccak256(code).toLowerCase() !== V6_FACTORY_RUNTIME_CODE_HASH.toLowerCase()) {
    throw new Error("V6 factory runtime code does not match the verified Robinhood testnet deployment snapshot; refusing to continue.");
  }
}

// Community-indexer address book. Revalidate on the live RPC before relying on it.
export const FACTORIES = [
  { generation: "retired", address: "0x4FEbC267e0C24440bcDEF72B5DBC5FE7BED091dF" as const, deploymentBlock: 95_916_239 },
  { generation: "legacy", address: "0xB5B7A2f6c4EAFa2D73918fcA32d50e2126339eb9" as const, deploymentBlock: 108_435_450 },
  { generation: "current", address: "0x40f1be6faf8DAB9C143cce1a0A04c2075Fb2DF59" as const, deploymentBlock: 115_025_604 },
] as const;
