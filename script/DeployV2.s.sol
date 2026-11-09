// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchcastV2} from "../contracts/LaunchcastV2.sol";

interface VmDeployV2 {
    function envUint(string calldata name) external returns (uint256);
    function envAddress(string calldata name) external returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Separate, explicit V2 deployment. Does not modify or replace the V1 contract.
contract DeployLaunchcastV2 {
    error WrongChain();
    error InvalidFee();

    uint256 private constant ROBINHOOD_CHAIN_TESTNET_ID = 46630;
    VmDeployV2 private constant vm = VmDeployV2(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        if (block.chainid != ROBINHOOD_CHAIN_TESTNET_ID) revert WrongChain();

        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address stakeToken = vm.envAddress("STAKE_TOKEN_ADDRESS");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint256 feeBpsRaw = vm.envUint("FEE_BPS");
        if (feeBpsRaw > 1_000) revert InvalidFee();
        uint16 feeBps = uint16(feeBpsRaw);
        address[3] memory resolvers =
            [vm.envAddress("RESOLVER_1"), vm.envAddress("RESOLVER_2"), vm.envAddress("RESOLVER_3")];

        vm.startBroadcast(privateKey);
        LaunchcastV2 launchcastV2 = new LaunchcastV2(stakeToken, feeRecipient, feeBps, resolvers);
        vm.stopBroadcast();

        launchcastV2;
    }
}
