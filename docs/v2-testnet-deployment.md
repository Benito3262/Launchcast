# Launchcast V2 testnet deployment runbook

This deploys a new V2 contract on Robinhood Chain Testnet (chain ID 46630). It does not replace or upgrade the existing V1 contract.

## 1. Configure GitHub Actions secrets

In the repository's GitHub Settings → Secrets and variables → Actions, add:

| Secret | Purpose |
| --- | --- |
| `LAUNCHCAST_TESTNET_PRIVATE_KEY` | Dedicated testnet deployer key with testnet ETH for gas |
| `LAUNCHCAST_STAKE_TOKEN_ADDRESS` | Existing testnet stake-token contract |
| `LAUNCHCAST_FEE_RECIPIENT` | Separate fee recipient address |
| `LAUNCHCAST_V2_RESOLVER_1` | Resolver address 1 |
| `LAUNCHCAST_V2_RESOLVER_2` | Resolver address 2 |
| `LAUNCHCAST_V2_RESOLVER_3` | Resolver address 3 |

The deployer, stake token, fee recipient and three resolver addresses must satisfy the contract's separation rules. The three resolver addresses must be distinct. Use a dedicated testnet deployer wallet; never use a mainnet wallet holding real assets.

## 2. Run the deployment workflow

1. Open **Actions → Deploy Launchcast V2 to Robinhood Testnet**.
2. Select the reviewed V2 branch.
3. Set `confirm_testnet_deployment` to `yes`.
4. Set the fee in basis points. Start with `0` on testnet unless the fee configuration has been explicitly approved.
5. Run the workflow and wait for the Foundry tests and deployment to complete.

The workflow validates chain ID, deployer gas balance, stake-token bytecode, fee limits, and resolver address separation before broadcasting. On success, it extracts the V2 contract address from Foundry's broadcast record and writes it to the GitHub Actions run summary.

## 3. Activate the V2 frontend

Copy the deployed address from the Actions run summary. In the Vercel project settings, add this environment variable to the Preview and Production environments:

`VITE_LAUNCHCAST_V2_ADDRESS=0x...`

Redeploy the relevant Vercel environment. The frontend reads this variable first and falls back to `launchcastV2Address` in `/data/deployment.json`.

Do not point the V2 frontend at the V1 contract. The V2 address must be the address emitted by the V2 deployment workflow.

## 4. Configure resolver operations

The resolver service and relayer are separate from the deployer:

- Each resolver instance needs `LAUNCHCAST_V2_ADDRESS`, an archive-capable `ARCHIVE_RPC_URL`, a genuinely independent `SECONDARY_ARCHIVE_RPC_URL`, and its own `RESOLVER_PRIVATE_KEY`.
- Two independent resolver instances must reproduce the same canonical observation and evidence digest and sign it with two different addresses from the market's snapshotted 2-of-3 committee.
- A separate funded `RELAYER_PRIVATE_KEY` broadcasts the signed attestation bundle. The relayer key is not a resolver key and cannot create a quorum by itself.

Validate historical reads against both archive providers before enabling resolver signing. The candidate providers in the discovery README are not automatically trusted simply because they advertise archive support.

## 5. Mandatory testnet acceptance flow

Before opening the V2 markets to users, complete one end-to-end test for each market type:

1. Create a market using a canonical V6 launch timestamp and verify its token/curve/pair configuration.
2. Place YES and NO positions from separate wallets.
3. Confirm that a graduation market stops accepting new positions as soon as the V6 curve reports `complete()`.
4. Generate and independently cross-check the historical observation evidence.
5. Submit a 2-of-3 attestation, test the challenge path, and finalize a valid result.
6. Claim winning payouts; test the no-winning-pool refund and void/dispute refunds.
7. Reconcile all stake-token balances, pool accounting and fee balances against the on-chain contract.

V2 is testnet-only and not audited. Do not enable real-value staking or treat the resolver committee as trustless.
