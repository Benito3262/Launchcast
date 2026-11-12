// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchcastRounds} from "../contracts/LaunchcastRounds.sol";

interface VmDeployRounds {
    function envUint(string calldata name) external returns (uint256);
    function envAddress(string calldata name) external returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Deploys LaunchCast V2 live rounds. Separate from (and does not modify) V1 or the V2 curated market contract.
contract DeployLaunchcastRounds {
    error WrongChain();

    uint256 private constant ROBINHOOD_CHAIN_TESTNET_ID = 46630;
    VmDeployRounds private constant vm = VmDeployRounds(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        if (block.chainid != ROBINHOOD_CHAIN_TESTNET_ID) revert WrongChain();
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address factory = vm.envAddress("VIBE_V6_FACTORY");
        address stakeToken = vm.envAddress("STAKE_TOKEN_ADDRESS");
        vm.startBroadcast(privateKey);
        new LaunchcastRounds(factory, stakeToken);
        vm.stopBroadcast();
    }
}
