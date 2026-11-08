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


contract FeeOnTransferToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }
    function _transfer(address from, address to, uint256 amount) private {
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
    }
}


contract SenderFeeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public taxedSender;

    function setTaxedSender(address sender) external { taxedSender = sender; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }
    function _transfer(address from, address to, uint256 amount) private {
        balanceOf[from] -= from == taxedSender ? amount + 1 : amount;
        balanceOf[to] += amount;
    }
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
    address private constant CAROL = address(0xCA401);
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
        token.transfer(CAROL, 1_000 * 10 ** 6);
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

        vm.prank(FEE_RECIPIENT);
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


    function testProportionalPayoutAndRoundingDust() public {
        uint256 marketId = _createMarket();
        _bet(ALICE, marketId, true, 3);
        _bet(BOB, marketId, true, 7);
        _bet(CAROL, marketId, false, 11);

        curve.setGraduated(true);
        vm.warp(block.timestamp + 2 days);
        launchcast.settleMarket(marketId);

        vm.prank(ALICE);
        uint256 alicePayout = launchcast.claim(marketId);
        vm.prank(BOB);
        uint256 bobPayout = launchcast.claim(marketId);
        require(alicePayout == 6, "wrong first proportional payout");
        require(bobPayout == 14, "wrong second proportional payout");
        require(token.balanceOf(address(launchcast)) == 1, "rounding remainder mismatch");
        require(launchcast.accruedFees() == 0, "unexpected fee");
    }



    function testRejectsSenderFeeOnDeposit() public {
        SenderFeeToken taxedToken = new SenderFeeToken();
        Launchcast taxedLaunchcast = new Launchcast(address(taxedToken), FEE_RECIPIENT, 500);
        taxedToken.mint(ALICE, 1_000);
        taxedToken.setTaxedSender(ALICE);
        uint256 marketId = taxedLaunchcast.createMarket(address(curve), uint64(block.timestamp + 1 days));

        vm.prank(ALICE);
        taxedToken.approve(address(taxedLaunchcast), 100);
        vm.expectRevert(Launchcast.TransferFailed.selector);
        vm.prank(ALICE);
        taxedLaunchcast.placeBet(marketId, true, 100);
    }

    function testRejectsSenderFeeOnPayout() public {
        SenderFeeToken taxedToken = new SenderFeeToken();
        Launchcast taxedLaunchcast = new Launchcast(address(taxedToken), FEE_RECIPIENT, 0);
        taxedToken.mint(ALICE, 1_000);
        taxedToken.mint(BOB, 1_000);
        taxedToken.setTaxedSender(address(taxedLaunchcast));
        uint256 marketId = taxedLaunchcast.createMarket(address(curve), uint64(block.timestamp + 1 days));

        vm.prank(ALICE);
        taxedToken.approve(address(taxedLaunchcast), 100);
        vm.prank(ALICE);
        taxedLaunchcast.placeBet(marketId, true, 100);
        vm.prank(BOB);
        taxedToken.approve(address(taxedLaunchcast), 100);
        vm.prank(BOB);
        taxedLaunchcast.placeBet(marketId, false, 100);

        taxedToken.mint(address(taxedLaunchcast), 1); // Ensure the sender-tax transfer executes so the delta check is exercised.
        curve.setGraduated(true);
        vm.warp(block.timestamp + 2 days);
        taxedLaunchcast.settleMarket(marketId);

        vm.expectRevert(Launchcast.TransferFailed.selector);
        vm.prank(ALICE);
        taxedLaunchcast.claim(marketId);
    }

    function testRejectsFeeOnTransferStakeToken() public {
        FeeOnTransferToken taxedToken = new FeeOnTransferToken();
        Launchcast taxedLaunchcast = new Launchcast(address(taxedToken), FEE_RECIPIENT, 500);
        taxedToken.mint(ALICE, 1_000);
        uint256 marketId = taxedLaunchcast.createMarket(address(curve), uint64(block.timestamp + 1 days));

        vm.prank(ALICE);
        taxedToken.approve(address(taxedLaunchcast), 100);
        vm.expectRevert(Launchcast.TransferFailed.selector);
        vm.prank(ALICE);
        taxedLaunchcast.placeBet(marketId, true, 100);
    }

    function testNoFeeWhenThereIsNoLosingPool() public {
        uint256 marketId = _createMarket();
        _bet(ALICE, marketId, true, 100 * 10 ** 6);

        curve.setGraduated(true);
        vm.warp(block.timestamp + 2 days);
        launchcast.settleMarket(marketId);

        vm.prank(ALICE);
        uint256 payout = launchcast.claim(marketId);
        require(payout == 100 * 10 ** 6, "winner stake not returned");
        require(launchcast.marketFee(marketId) == 0, "fee charged without losing pool");
        require(launchcast.accruedFees() == 0, "fees accrued without losing pool");
    }

    function testConstructorRejectsNonContractStakeToken() public {
        vm.expectRevert(Launchcast.InvalidToken.selector);
        new Launchcast(address(0x1234), FEE_RECIPIENT, 500);
    }


    function testClaimCannotBeRepeated() public {
        uint256 marketId = _createMarket();
        _bet(ALICE, marketId, true, 100 * 10 ** 6);
        _bet(BOB, marketId, false, 100 * 10 ** 6);
        curve.setGraduated(true);
        vm.warp(block.timestamp + 2 days);
        launchcast.settleMarket(marketId);

        vm.prank(ALICE);
        launchcast.claim(marketId);
        vm.expectRevert(Launchcast.AlreadyClaimed.selector);
        vm.prank(ALICE);
        launchcast.claim(marketId);
    }

    function testUserWithPositionsOnBothSidesReceivesNetPayout() public {
        uint256 marketId = _createMarket();
        _bet(ALICE, marketId, true, 100 * 10 ** 6);
        _bet(ALICE, marketId, false, 40 * 10 ** 6);
        _bet(BOB, marketId, false, 100 * 10 ** 6);
        curve.setGraduated(true);
        vm.warp(block.timestamp + 2 days);
        launchcast.settleMarket(marketId);

        vm.prank(ALICE);
        uint256 payout = launchcast.claim(marketId);
        // YES stake wins its share of the losing pool; ALICE's NO stake is part of that pool.
        require(payout == 233 * 10 ** 6, "incorrect netted payout");
    }

    function testBatchSettlementWorksAndRejectsOversizedBatch() public {
        uint256 first = _createMarket();
        uint256 second = _createMarket();
        uint256[] memory ids = new uint256[](2);
        ids[0] = first;
        ids[1] = second;
        vm.warp(block.timestamp + 2 days);
        launchcast.settleMarkets(ids);
        require(launchcast.getMarket(first).resolved, "first market unresolved");
        require(launchcast.getMarket(second).resolved, "second market unresolved");

        uint256[] memory tooMany = new uint256[](26);
        vm.expectRevert(Launchcast.InvalidBatch.selector);
        launchcast.settleMarkets(tooMany);
    }

    function testBatchSettlementRevertsAtomicallyOnDuplicateMarket() public {
        uint256 marketId = _createMarket();
        uint256[] memory ids = new uint256[](2);
        ids[0] = marketId;
        ids[1] = marketId;
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(Launchcast.AlreadyResolved.selector);
        launchcast.settleMarkets(ids);
        require(!launchcast.getMarket(marketId).resolved, "partial batch settlement");
    }


    function testRejectsZeroBetAmount() public {
        uint256 marketId = _createMarket();
        vm.expectRevert(Launchcast.InvalidAmount.selector);
        vm.prank(ALICE);
        launchcast.placeBet(marketId, true, 0);
    }

    function testRejectsInvalidMarketId() public {
        vm.expectRevert(Launchcast.InvalidMarket.selector);
        launchcast.settleMarket(0);
    }

    function testRejectsCurveWithoutGraduatedGetter() public {
        vm.expectRevert(Launchcast.InvalidCurve.selector);
        launchcast.createMarket(address(token), uint64(block.timestamp + 1 days));
    }


    function testCannotSetLaunchcastAsFeeRecipient() public {
        vm.expectRevert(Launchcast.InvalidAddress.selector);
        launchcast.setFeeConfig(500, address(launchcast));
    }

    function testOwnerCannotSetFeeAboveMaximum() public {
        vm.expectRevert(Launchcast.InvalidFee.selector);
        launchcast.setFeeConfig(1_001, FEE_RECIPIENT);
    }

    function testNonOwnerCannotChangeFeeConfig() public {
        vm.expectRevert(Launchcast.Unauthorized.selector);
        vm.prank(ALICE);
        launchcast.setFeeConfig(100, FEE_RECIPIENT);
    }


    function testRejectsBetAbovePoolTypeLimit() public {
        uint256 marketId = _createMarket();
        vm.expectRevert(Launchcast.InvalidAmount.selector);
        vm.prank(ALICE);
        launchcast.placeBet(marketId, true, uint256(type(uint128).max) + 1);
    }

    function testRejectsBetOnUnknownMarket() public {
        vm.expectRevert(Launchcast.InvalidMarket.selector);
        vm.prank(ALICE);
        launchcast.placeBet(999, true, 1);
    }

    function testClaimBeforeResolutionReverts() public {
        uint256 marketId = _createMarket();
        _bet(ALICE, marketId, true, 10);
        vm.expectRevert(Launchcast.NotResolved.selector);
        vm.prank(ALICE);
        launchcast.claim(marketId);
    }

    function testUserWithoutPositionCannotClaim() public {
        uint256 marketId = _createMarket();
        vm.warp(block.timestamp + 2 days);
        launchcast.settleMarket(marketId);
        vm.expectRevert(Launchcast.NothingToClaim.selector);
        vm.prank(ALICE);
        launchcast.claim(marketId);
    }

    function testRejectsMarketWithPastOrCurrentResolveTime() public {
        vm.expectRevert(Launchcast.InvalidTime.selector);
        launchcast.createMarket(address(curve), uint64(block.timestamp));
    }

    function testRejectsZeroFeeRecipient() public {
        vm.expectRevert(Launchcast.InvalidAddress.selector);
        launchcast.setFeeConfig(100, address(0));
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
