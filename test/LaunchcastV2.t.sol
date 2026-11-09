// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchcastV2} from "../contracts/LaunchcastV2.sol";
import {TestUSD} from "../contracts/TestUSD.sol";

interface VmV2 {
    function warp(uint256 timestamp) external;
    function prank(address caller) external;
    function expectRevert(bytes4 revertData) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract CurveIdentityMockV2 {
    bool public complete;
    function setComplete(bool value) external { complete = value; }
}

contract ReentrantStakeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    LaunchcastV2 private target;
    uint256 private targetMarketId;
    bool private armed;
    bool public reentryBlocked;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function arm(address target_, uint256 marketId_) external {
        target = LaunchcastV2(target_);
        targetMarketId = marketId_;
        armed = true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (armed) {
            armed = false;
            try target.placeBet(targetMarketId, true, 1) {}
            catch {
                reentryBlocked = true;
            }
        }
        return true;
    }
}

contract LaunchcastV2Test {
    VmV2 private constant vm = VmV2(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant PK1 = 0xA11CE;
    uint256 private constant PK2 = 0xB0B;
    uint256 private constant PK3 = 0xC0FFEE;
    address private alice = address(0xA1);
    address private bob = address(0xB2);
    address private feeWallet = address(0xFEE);

    TestUSD private stake;
    CurveIdentityMockV2 private curve;
    LaunchcastV2 private market;
    address[3] private resolvers;
    uint64 private observationAt;
    uint64 private closeAt;

    function setUp() public {
        vm.warp(1_000_000);
        stake = new TestUSD();
        curve = new CurveIdentityMockV2();
        resolvers = [vm.addr(PK1), vm.addr(PK2), vm.addr(PK3)];
        market = new LaunchcastV2(address(stake), feeWallet, 500, resolvers);
        observationAt = uint64(block.timestamp + 12 hours);
        closeAt = uint64(block.timestamp + 11 hours);
        _fundAndApprove(alice);
        _fundAndApprove(bob);
    }

    function testResolverCommitteeMustBeSeparateFromOwnerAndFeeRecipient() public {
        address[3] memory resolverSet = [resolvers[0], feeWallet, resolvers[2]];
        vm.expectRevert(LaunchcastV2.InvalidResolverSet.selector);
        new LaunchcastV2(address(stake), feeWallet, 0, resolverSet);
    }

    function testOwnerCannotAlsoBeFeeRecipient() public {
        vm.expectRevert(LaunchcastV2.InvalidAddress.selector);
        new LaunchcastV2(address(stake), address(this), 0, resolvers);
    }

    function testOwnershipCannotTransferToResolver() public {
        vm.expectRevert(LaunchcastV2.InvalidAddress.selector);
        market.transferOwnership(resolvers[0]);
    }

    function testFeeRecipientCannotBeChangedToResolver() public {
        vm.expectRevert(LaunchcastV2.InvalidAddress.selector);
        market.setFeeConfig(0, resolvers[0]);
    }

    function testCreatesIndependentTwelveAndTwentyFourHourMarkets() public {
        uint256 twelve = _create(LaunchcastV2.MarketType.Fdv12Hour, 1_000e18);
        uint256 twentyFour = market.createMarket(
            LaunchcastV2.MarketType.Fdv24Hour,
            address(stake),
            address(curve),
            address(stake),
            uint64(block.timestamp),
            observationAt + 12 hours,
            closeAt + 12 hours,
            60,
            2_000e18
        );
        LaunchcastV2.Market memory a = market.getMarket(twelve);
        LaunchcastV2.Market memory b = market.getMarket(twentyFour);
        require(a.marketType == LaunchcastV2.MarketType.Fdv12Hour, "wrong 12h type");
        require(b.marketType == LaunchcastV2.MarketType.Fdv24Hour, "wrong 24h type");
        require(a.targetFdv == 1_000e18 && b.targetFdv == 2_000e18, "threshold not fixed");
        require(a.observationAt != b.observationAt, "observation shared");
    }

    function testFdvAttestationFinalizeAndClaim() public {
        uint256 id = _create(LaunchcastV2.MarketType.Fdv12Hour, 1_000e18);
        _bet(id, alice, true, 100e6);
        _bet(id, bob, false, 50e6);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("historical V4 observation evidence");
        bytes[] memory sigs = _sign(id, true, 1_500e18, evidence, 150_000_000);
        market.submitAttestation(id, true, 150_000_000, observationAt, keccak256("block"), evidence, 1_500e18, sigs);
        LaunchcastV2.Market memory challenged = market.getMarket(id);
        require(challenged.status == LaunchcastV2.MarketStatus.Challenged, "not challenged");
        vm.warp(challenged.challengeEndsAt + 1);
        market.finalizeMarket(id);
        LaunchcastV2.Market memory resolved = market.getMarket(id);
        require(resolved.status == LaunchcastV2.MarketStatus.Resolved, "not resolved");
        uint256 beforeAlice = stake.balanceOf(alice);
        vm.prank(alice);
        uint256 payout = market.claim(id);
        require(payout == 147_500_000, "wrong proportional payout");
        require(stake.balanceOf(alice) == beforeAlice + payout, "winner not paid");
        vm.expectRevert(LaunchcastV2.NothingToClaim.selector);
        vm.prank(bob);
        market.claim(id);
        require(!market.hasClaimed(id, bob), "losing position marked claimed");
        require(market.accruedFeesByRecipient(feeWallet) == 2_500_000, "fee mismatch");
        vm.prank(feeWallet);
        market.withdrawFees();
        require(stake.balanceOf(feeWallet) == 2_500_000, "fee recipient not paid");
    }

    function testLosingPositionCannotClaimOrMarkItselfClaimed() public {
        uint256 id = _create(LaunchcastV2.MarketType.Graduation, 0);
        _bet(id, alice, true, 100e6);
        _bet(id, bob, false, 50e6);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("graduation NO evidence");
        bytes[] memory sigs = _sign(id, false, 0, evidence, 150_000_000);
        market.submitAttestation(id, false, 150_000_000, observationAt, keccak256("block"), evidence, 0, sigs);
        LaunchcastV2.Market memory challenged = market.getMarket(id);
        vm.warp(challenged.challengeEndsAt + 1);
        market.finalizeMarket(id);
        vm.expectRevert(LaunchcastV2.NothingToClaim.selector);
        vm.prank(alice);
        market.claim(id);
        require(!market.hasClaimed(id, alice), "losing position marked claimed");
        vm.prank(bob);
        require(market.claim(id) > 0, "winning position could not claim");
    }

    function testConflictingQuorumVoidsAndRefundsBothSides() public {
        uint256 id = _create(LaunchcastV2.MarketType.Fdv12Hour, 1_000e18);
        _bet(id, alice, true, 10e6);
        _bet(id, bob, false, 20e6);
        vm.warp(observationAt);
        bytes32 firstEvidence = keccak256("first evidence");
        bytes[] memory first = _sign(id, true, 1_200e18, firstEvidence, 150_000_000);
        market.submitAttestation(
            id, true, 150_000_000, observationAt, keccak256("block"), firstEvidence, 1_200e18, first
        );
        bytes32 secondEvidence = keccak256("conflicting evidence");
        bytes[] memory second = _signWith(id, false, 900e18, secondEvidence, 150_000_001, PK2, PK3);
        market.challengeAttestation(
            id, false, 150_000_001, observationAt, keccak256("block"), secondEvidence, 900e18, second
        );
        require(market.getMarket(id).status == LaunchcastV2.MarketStatus.Disputed, "not disputed");
        market.voidDisputedMarket(id);
        require(market.getMarket(id).status == LaunchcastV2.MarketStatus.Voided, "not voided");
        vm.prank(alice);
        require(market.claim(id) == 10e6, "yes refund failed");
        vm.prank(bob);
        require(market.claim(id) == 20e6, "no refund failed");
    }

    function testGraduationAttestationFinalizeAndClaim() public {
        uint256 id = _create(LaunchcastV2.MarketType.Graduation, 0);
        _bet(id, alice, true, 100e6);
        _bet(id, bob, false, 50e6);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("historical graduation evidence");
        bytes[] memory sigs = _sign(id, true, 0, evidence, 150_000_000);
        market.submitAttestation(id, true, 150_000_000, observationAt, keccak256("block"), evidence, 0, sigs);
        LaunchcastV2.Market memory challenged = market.getMarket(id);
        require(challenged.status == LaunchcastV2.MarketStatus.Challenged, "graduation not challenged");
        vm.warp(challenged.challengeEndsAt + 1);
        market.finalizeMarket(id);
        require(market.getMarket(id).status == LaunchcastV2.MarketStatus.Resolved, "graduation not resolved");
        vm.prank(alice);
        require(market.claim(id) == 147_500_000, "graduation payout mismatch");
    }

    function testGraduationNoOutcomePaysNoSide() public {
        uint256 id = _create(LaunchcastV2.MarketType.Graduation, 0);
        _bet(id, alice, false, 40e6);
        _bet(id, bob, true, 10e6);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("historical non-graduation evidence");
        bytes[] memory sigs = _sign(id, false, 0, evidence, 150_000_000);
        market.submitAttestation(id, false, 150_000_000, observationAt, keccak256("block"), evidence, 0, sigs);
        LaunchcastV2.Market memory challenged = market.getMarket(id);
        vm.warp(challenged.challengeEndsAt + 1);
        market.finalizeMarket(id);
        vm.prank(alice);
        require(market.claim(id) == 49_500_000, "graduation NO payout mismatch");
    }

    function testGraduationWithNoWinningPoolRefundsEveryPosition() public {
        uint256 id = _create(LaunchcastV2.MarketType.Graduation, 0);
        _bet(id, alice, false, 40e6); // YES is the eventual outcome, but nobody backed YES.
        uint256 balanceBeforeClaim = stake.balanceOf(alice);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("graduation with empty winning pool");
        bytes[] memory sigs = _sign(id, true, 0, evidence, 150_000_000);
        market.submitAttestation(id, true, 150_000_000, observationAt, keccak256("block"), evidence, 0, sigs);
        LaunchcastV2.Market memory challenged = market.getMarket(id);
        vm.warp(challenged.challengeEndsAt + 1);
        market.finalizeMarket(id);
        vm.prank(alice);
        require(market.claim(id) == 40e6, "empty winning pool did not refund stake");
        require(stake.balanceOf(alice) == balanceBeforeClaim + 40e6, "refund was not transferred");
        require(market.hasClaimed(id, alice), "refund claim was not recorded");
        require(market.accruedFees() == 0, "fee charged when no winning pool existed");
    }

    function testGraduationAttestationRejectsNonzeroFdvValue() public {
        uint256 id = _create(LaunchcastV2.MarketType.Graduation, 0);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("invalid graduation FDV evidence");
        bytes[] memory sigs = _sign(id, true, 1, evidence, 150_000_000);
        vm.expectRevert(LaunchcastV2.InvalidEvidence.selector);
        market.submitAttestation(id, true, 150_000_000, observationAt, keccak256("block"), evidence, 1, sigs);
    }

    function testNoAttestationEventuallyVoidsAndRefunds() public {
        uint256 id = _create(LaunchcastV2.MarketType.Graduation, 0);
        _bet(id, alice, true, 3e6);
        vm.warp(observationAt + 24 hours + 1);
        market.voidUnattestedMarket(id);
        vm.prank(alice);
        require(market.claim(id) == 3e6, "timeout refund failed");
    }

    function testRejectsFdVOutcomeThatDoesNotMatchAttestedValue() public {
        observationAt += 12 hours;
        closeAt += 12 hours;
        uint256 id = _create(LaunchcastV2.MarketType.Fdv24Hour, 1_000e18);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("bad outcome");
        bytes[] memory sigs = _sign(id, true, 999e18, evidence, 150_000_000);
        vm.expectRevert(LaunchcastV2.InvalidEvidence.selector);
        market.submitAttestation(id, true, 150_000_000, observationAt, keccak256("block"), evidence, 999e18, sigs);
    }

    function testRejectsStaleObservationBlockTimestamp() public {
        uint256 id = _create(LaunchcastV2.MarketType.Fdv12Hour, 1_000e18);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("stale evidence");
        bytes[] memory sigs = _sign(id, true, 1_100e18, evidence, 150_000_000);
        vm.expectRevert(LaunchcastV2.InvalidEvidence.selector);
        market.submitAttestation(
            id, true, 150_000_000, observationAt - 61, keccak256("block"), evidence, 1_100e18, sigs
        );
    }

    function testResolverRotationDoesNotChangeExistingMarketQuorum() public {
        uint256 id = _create(LaunchcastV2.MarketType.Fdv12Hour, 1_000e18);
        address[3] memory nextSet = [address(0x111), address(0x222), address(0x333)];
        market.setResolvers(nextSet);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("old resolver set");
        bytes[] memory sigs = _sign(id, true, 1_100e18, evidence, 150_000_000);
        market.submitAttestation(id, true, 150_000_000, observationAt, keccak256("block"), evidence, 1_100e18, sigs);
        require(market.getMarket(id).status == LaunchcastV2.MarketStatus.Challenged, "snapshot resolver set lost");
    }

    function testRejectsQuorumSignedByNonResolver() public {
        uint256 id = _create(LaunchcastV2.MarketType.Fdv12Hour, 1_000e18);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("outsider signature");
        bytes[] memory sigs = _signWith(id, true, 1_100e18, evidence, 150_000_000, PK1, 0xBAD);
        vm.expectRevert(LaunchcastV2.InvalidSignatures.selector);
        market.submitAttestation(id, true, 150_000_000, observationAt, keccak256("block"), evidence, 1_100e18, sigs);
    }

    function testAttestationCannotBeReplayedAcrossMarkets() public {
        uint256 first = _create(LaunchcastV2.MarketType.Fdv12Hour, 1_000e18);
        uint256 second = _create(LaunchcastV2.MarketType.Fdv12Hour, 1_000e18);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("market one evidence");
        bytes[] memory sigs = _sign(first, true, 1_100e18, evidence, 150_000_000);
        vm.expectRevert(LaunchcastV2.InvalidSignatures.selector);
        market.submitAttestation(second, true, 150_000_000, observationAt, keccak256("block"), evidence, 1_100e18, sigs);
    }

    function testMarketVoidsWhenAttestedWinningSideHasNoStakes() public {
        uint256 id = _create(LaunchcastV2.MarketType.Graduation, 0);
        _bet(id, alice, false, 4e6);
        vm.warp(observationAt);
        bytes32 evidence = keccak256("no winning pool");
        bytes[] memory sigs = _sign(id, true, 0, evidence, 150_000_000);
        market.submitAttestation(id, true, 150_000_000, observationAt, keccak256("block"), evidence, 0, sigs);
        LaunchcastV2.Market memory challenged = market.getMarket(id);
        vm.warp(challenged.challengeEndsAt + 1);
        market.finalizeMarket(id);
        require(market.getMarket(id).status == LaunchcastV2.MarketStatus.Voided, "market not voided");
        vm.prank(alice);
        require(market.claim(id) == 4e6, "losing side not refunded");
    }

    function testRejectsWrongTwelveHourObservationTimestamp() public {
        vm.expectRevert(LaunchcastV2.InvalidTime.selector);
        market.createMarket(
            LaunchcastV2.MarketType.Fdv12Hour,
            address(stake),
            address(curve),
            address(stake),
            uint64(block.timestamp),
            observationAt + 1,
            closeAt,
            60,
            1_000e18
        );
    }

    function testStakeTokenCannotReenterAnyMarketMutationDuringTransfer() public {
        ReentrantStakeToken malicious = new ReentrantStakeToken();
        LaunchcastV2 guarded = new LaunchcastV2(address(malicious), feeWallet, 0, resolvers);
        uint256 id = guarded.createMarket(
            LaunchcastV2.MarketType.Graduation,
            address(stake),
            address(curve),
            address(0),
            uint64(block.timestamp),
            observationAt,
            closeAt,
            60,
            0
        );
        malicious.mint(alice, 100e18);
        vm.prank(alice);
        malicious.approve(address(guarded), 100e18);
        malicious.arm(address(guarded), id);
        vm.prank(alice);
        guarded.placeBet(id, true, 10e18);
        require(malicious.reentryBlocked(), "reentrant call was not blocked");
        LaunchcastV2.Market memory created = guarded.getMarket(id);
        require(created.yesPool == 10e18, "reentrant stake changed the pool");
    }

    function testGraduationMarketStopsBettingAsSoonAsCurveCompletes() public {
        uint256 id = _create(LaunchcastV2.MarketType.Graduation, 0);
        _bet(id, alice, true, 1e6);
        curve.setComplete(true);
        vm.expectRevert(LaunchcastV2.MarketClosed.selector);
        vm.prank(bob);
        market.placeBet(id, false, 1e6);
    }

    function testGraduationMarketCannotBeCreatedForCompletedCurve() public {
        curve.setComplete(true);
        vm.expectRevert(LaunchcastV2.InvalidMarket.selector);
        market.createMarket(
            LaunchcastV2.MarketType.Graduation, address(stake), address(curve), address(0),
            uint64(block.timestamp), observationAt, closeAt, 60, 0
        );
    }

    function testFdvMarketRequiresCompletedCurve() public {
        curve.setComplete(false);
        vm.expectRevert(LaunchcastV2.InvalidMarket.selector);
        market.createMarket(
            LaunchcastV2.MarketType.Fdv12Hour, address(stake), address(curve), address(stake),
            uint64(block.timestamp), observationAt, closeAt, 60, 1_000e18
        );
    }

    function testRejectsBetAfterClose() public {
        uint256 id = _create(LaunchcastV2.MarketType.Graduation, 0);
        vm.warp(closeAt);
        vm.expectRevert(LaunchcastV2.MarketClosed.selector);
        vm.prank(alice);
        market.placeBet(id, true, 1e6);
    }

    function _create(LaunchcastV2.MarketType kind, uint256 target) private returns (uint256) {
        curve.setComplete(kind != LaunchcastV2.MarketType.Graduation);
        address pair = kind == LaunchcastV2.MarketType.Graduation ? address(0) : address(stake);
        return market.createMarket(
            kind, address(stake), address(curve), pair, uint64(block.timestamp), observationAt, closeAt, 60, target
        );
    }

    function _fundAndApprove(address user) private {
        vm.prank(user);
        stake.faucet();
        vm.prank(user);
        stake.approve(address(market), type(uint256).max);
    }

    function _bet(uint256 id, address user, bool side, uint256 amount) private {
        vm.prank(user);
        market.placeBet(id, side, amount);
    }

    function _sign(uint256 id, bool outcome, uint256 fdv, bytes32 evidence, uint64 obsBlock)
        private
        returns (bytes[] memory)
    {
        return _signWith(id, outcome, fdv, evidence, obsBlock, PK1, PK2);
    }

    function _signWith(
        uint256 id,
        bool outcome,
        uint256 fdv,
        bytes32 evidence,
        uint64 obsBlock,
        uint256 keyA,
        uint256 keyB
    ) private returns (bytes[] memory signatures) {
        bytes32 digest = market.attestationDigest(
            id, outcome, obsBlock, observationAt, keccak256("block"), evidence, fdv
        );
        // Callers can use a distinct block hash in the submitted payload; this helper signs the canonical test hash.
        (uint8 vA, bytes32 rA, bytes32 sA) = vm.sign(keyA, digest);
        (uint8 vB, bytes32 rB, bytes32 sB) = vm.sign(keyB, digest);
        address a = vm.addr(keyA);
        address b = vm.addr(keyB);
        signatures = new bytes[](2);
        if (a < b) {
            signatures[0] = abi.encodePacked(rA, sA, vA);
            signatures[1] = abi.encodePacked(rB, sB, vB);
        } else {
            signatures[0] = abi.encodePacked(rB, sB, vB);
            signatures[1] = abi.encodePacked(rA, sA, vA);
        }
    }
}
