export const CHAIN_ID = 46630;
export const DEFAULT_RPC = "https://rpc.testnet.chain.robinhood.com";

// Community-indexer address book. Revalidate on the live RPC before relying on it.
export const FACTORIES = [
  { generation: "retired", address: "0x4FEbC267e0C24440bcDEF72B5DBC5FE7BED091dF" as const, deploymentBlock: 95_916_239 },
  { generation: "legacy", address: "0xB5B7A2f6c4EAFa2D73918fcA32d50e2126339eb9" as const, deploymentBlock: 108_435_450 },
  { generation: "current", address: "0x40f1be6faf8DAB9C143cce1a0A04c2075Fb2DF59" as const, deploymentBlock: 115_025_604 },
] as const;
