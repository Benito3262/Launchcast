// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Launchcast} from "../contracts/Launchcast.sol";
import {TestUSD} from "../contracts/TestUSD.sol";

interface VmDeploy {
    function envUint(string calldata name) external returns (uint256);
    function envAddress(string calldata name) external returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployLaunchcast {
    error WrongChain();
    uint256 private constant ROBINHOOD_CHAIN_TESTNET_ID = 46630;

    VmDeploy private constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        if (block.chainid != ROBINHOOD_CHAIN_TESTNET_ID) revert WrongChain();

        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        vm.startBroadcast(privateKey);
        TestUSD testUSD = new TestUSD();
        Launchcast launchcast = new Launchcast(address(testUSD), feeRecipient, 0);
        vm.stopBroadcast();

        // Deployment addresses are available in the Foundry broadcast artifact.
        launchcast;
        testUSD;
    }
}
