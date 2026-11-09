# Launchcast V2 testnet deployment runbook

This deploys a new V2 contract on Robinhood Chain Testnet (chain ID 46630). It does not replace or upgrade the existing V1 contract.

## 1. Existing verified testnet deployment

The successful V1 GitHub Actions deployment on 2026-11-08 produced this Foundry broadcast artifact. The V2 workflow uses the existing TestUSD token and the existing fee recipient:

| Item | Verified value |
| --- | --- |
| Chain ID | `46630` |
| Existing TestUSD stake token | `0x9557aade5c89fe39941b4f3a60cbac16e3f32143` |
| Existing fee recipient | `0x54032f2d6adc9b327f5f2222d5ae1d6346a2cb14` |
| Existing V1 Launchcast | `0x091413de1302640f78d41e2370507c1a8f774c45` |

The fee-recipient address is decoded from the successful V1 deployment transaction's constructor arguments. These are public addresses, not secrets.

## 2. GitHub Actions environment

The V2 workflow now asks for the exact GitHub Environment name at dispatch time and attaches the deployment job to that environment. It accepts the deployment private key under either secret name:

- `LAUNCHCAST_TESTNET_PRIVATE_KEY` (preferred)
- `PRIVATE_KEY` (compatibility alias)

The public key is not needed by the deployment script because Foundry derives the deployer address from the private key. Never paste or print the private key. The workflow does not need a public-key secret.

The connected GitHub integration cannot enumerate repository environments or read secret names. Enter the exact environment name shown in **Settings → Environments** when dispatching the workflow. If the environment name is wrong or the private key secret is unavailable, the job fails during its preflight checks before broadcasting.

## 3. Resolver addresses are a separate requirement

The workflow takes three public resolver EOA addresses as manual dispatch inputs. These must be three distinct addresses and must not equal the deployer, fee recipient, or stake-token contract. The workflow checks address format, distinctness, EOA bytecode, chain ID, deployer gas balance, stake-token bytecode, and fee limit before deployment.

**Do not enter the deployer's public address as a resolver.** The V2 contract explicitly rejects the owner/deployer address in the resolver committee. The three resolver addresses must each have independently controlled private signing keys, held securely by the resolver operators. The deployer's one private key and public address do not create a 2-of-3 resolver committee.

Do not invent resolver addresses or use addresses for which no one controls the private keys. Resolver private keys are not needed by the contract deployment workflow itself, but they are required later to sign attestations. The independent resolver services and relayer must be configured and tested before markets rely on automated resolution.

## 4. Run the deployment workflow

1. Open **Actions → Deploy Launchcast V2 to Robinhood Testnet** on the reviewed V2 branch.
2. Set `confirm_testnet_deployment` to `yes` only when ready to deploy.
3. Enter the exact GitHub Environment name that contains the deployer private-key secret.
4. Enter three distinct, independently controlled resolver EOA addresses.
5. Set the fee in basis points. Use `0` on testnet unless a different fee has been explicitly approved.
6. Run the workflow and wait for the Foundry tests and all preflight checks to pass.

The workflow deploys a separate V2 contract and reports its address in the Actions run summary. Do not point the frontend at V1 as a V2 contract.

## 5. Activate the V2 frontend

After a successful V2 deployment, copy the V2 address from the Actions run summary. In the Vercel project settings, add this environment variable to the intended Preview environment first:

`VITE_LAUNCHCAST_V2_ADDRESS=0x...`

Redeploy Preview and test the complete acceptance flow before considering Production. Only after successful testnet acceptance should the same address be configured for Production.

## 6. Mandatory testnet acceptance flow

Before opening V2 markets to users, complete one end-to-end test for each market type:

1. Create a market using a canonical V6 launch timestamp and verify its token/curve/pair configuration.
2. Place YES and NO positions from separate wallets.
3. Confirm that a graduation market stops accepting new positions as soon as the V6 curve reports `complete()`.
4. Generate and independently cross-check the historical observation evidence against two archive providers.
5. Submit a 2-of-3 attestation, test the challenge path, and finalize a valid result.
6. Claim winning payouts; test the no-winning-pool refund and void/dispute refunds.
7. Reconcile all stake-token balances, pool accounting and fee balances against the on-chain contract.

V2 is testnet-only and not audited. Do not enable real-value staking or treat the resolver committee as trustless.
