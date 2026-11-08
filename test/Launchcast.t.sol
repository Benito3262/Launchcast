// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Launchcast} from "../contracts/Launchcast.sol";
import {TestUSD} from "../contracts/TestUSD.sol";

interface Vm {
    function warp(uint256 timestamp) external;
    function prank(address caller) external;
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
}

contract MockVibeVibeCurve {
    bool public graduated;

    function setGraduated(bool value) external {
        graduated = value;
    }
}

contract LaunchcastTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant FEE_RECIPIENT = address(0xFEE);

    TestUSD private token;
    Launchcast private launchcast;
    MockVibeVibeCurve private curve;

    function setUp() public {
        token = new TestUSD();
        launchcast = new Launchcast(address(token), FEE_RECIPIENT, 500); // 5% of losing pool
        curve = new MockVibeVibeCurve();

        token.faucet();
        token.transfer(ALICE, 1_000 * 10 ** 6);
        token.transfer(BOB, 1_000 * 10 ** 6);
    }

    function testYesWinsAndFeeIsTakenFromLosingPool() public {
        uint256 marketId = _createMarket();
        _bet(ALICE, marketId, true, 100 * 10 ** 6);
        _bet(BOB, marketId, false, 100 * 10 ** 6);

        curve.setGraduated(true);
        vm.warp(block.timestamp + 2 days);
        launchcast.settleMarket(marketId);

        vm.prank(ALICE);
        uint256 payout = launchcast.claim(marketId);
        require(payout == 195 * 10 ** 6, "wrong winner payout");
        require(token.balanceOf(ALICE) == 1_095 * 10 ** 6, "wrong winner balance");

        launchcast.withdrawFees();
        require(token.balanceOf(FEE_RECIPIENT) == 5 * 10 ** 6, "wrong fee");
    }

    function testNoWins() public {
        uint256 marketId = _createMarket();
        _bet(ALICE, marketId, true, 100 * 10 ** 6);
        _bet(BOB, marketId, false, 100 * 10 ** 6);

        curve.setGraduated(false);
        vm.warp(block.timestamp + 2 days);
        launchcast.settleMarket(marketId);

        vm.prank(BOB);
        uint256 payout = launchcast.claim(marketId);
        require(payout == 195 * 10 ** 6, "wrong NO payout");
    }

    function testRefundIfNoOneBackedWinningSide() public {
        uint256 marketId = _createMarket();
        _bet(ALICE, marketId, true, 100 * 10 ** 6);

        curve.setGraduated(false);
        vm.warp(block.timestamp + 2 days);
        launchcast.settleMarket(marketId);

        vm.prank(ALICE);
        uint256 payout = launchcast.claim(marketId);
        require(payout == 100 * 10 ** 6, "stake not refunded");
    }

    function testSettlementIsPermissionlessAndCannotRepeat() public {
        uint256 marketId = _createMarket();
        vm.warp(block.timestamp + 2 days);
        vm.prank(BOB);
        launchcast.settleMarket(marketId);

        vm.expectRevert();
        launchcast.settleMarket(marketId);
    }

    function testCannotBetAfterSettlementTime() public {
        uint256 marketId = _createMarket();
        vm.warp(block.timestamp + 2 days);

        // Approve before expectRevert: the expected revert must apply to placeBet,
        // not to the ERC-20 approval performed by _bet().
        vm.prank(ALICE);
        token.approve(address(launchcast), 1 * 10 ** 6);

        vm.expectRevert(Launchcast.MarketClosed.selector);
        vm.prank(ALICE);
        launchcast.placeBet(marketId, true, 1 * 10 ** 6);
    }

    function testOnlyOwnerCanCreateMarket() public {
        vm.expectRevert();
        vm.prank(ALICE);
        launchcast.createMarket(address(curve), uint64(block.timestamp + 1 days));
    }


    function testFeeIsLockedWhenMarketSettles() public {
        uint256 marketId = _createMarket();
        _bet(ALICE, marketId, true, 100 * 10 ** 6);
        _bet(BOB, marketId, false, 100 * 10 ** 6);

        curve.setGraduated(true);
        vm.warp(block.timestamp + 2 days);
        launchcast.settleMarket(marketId);

        // Changing the global fee later must not change an already-settled market's payout.
        launchcast.setFeeConfig(1_000, address(0xFEE2));

        vm.prank(ALICE);
        uint256 payout = launchcast.claim(marketId);
        require(payout == 195 * 10 ** 6, "settled fee changed");
    }

    function testFeeRecipientRotationCannotRedirectAccruedFees() public {
        uint256 marketId = _createMarket();
        _bet(ALICE, marketId, true, 100 * 10 ** 6);
        _bet(BOB, marketId, false, 100 * 10 ** 6);

        curve.setGraduated(true);
        vm.warp(block.timestamp + 2 days);
        launchcast.settleMarket(marketId);

        require(launchcast.marketFeeRecipient(marketId) == FEE_RECIPIENT, "recipient not snapshotted");
        require(launchcast.accruedFeesByRecipient(FEE_RECIPIENT) == 5 * 10 ** 6, "old recipient fee missing");

        address newRecipient = address(0xFEE2);
        launchcast.setFeeConfig(500, newRecipient);

        vm.expectRevert(Launchcast.NothingToClaim.selector);
        vm.prank(newRecipient);
        launchcast.withdrawFees();

        vm.prank(FEE_RECIPIENT);
        launchcast.withdrawFees();

        require(token.balanceOf(FEE_RECIPIENT) == 5 * 10 ** 6, "old recipient could not withdraw");
        require(launchcast.accruedFees() == 0, "aggregate fees not cleared");
    }

    function testCannotSettleBeforeResolveAfter() public {
        uint256 marketId = _createMarket();
        vm.expectRevert();
        launchcast.settleMarket(marketId);
    }

    function _createMarket() private returns (uint256) {
        return launchcast.createMarket(address(curve), uint64(block.timestamp + 1 days));
    }

    function _bet(address user, uint256 marketId, bool sideYes, uint256 amount) private {
        vm.prank(user);
        token.approve(address(launchcast), amount);
        vm.prank(user);
        launchcast.placeBet(marketId, sideYes, amount);
    }
}
