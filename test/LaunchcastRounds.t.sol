// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchcastRounds} from "../contracts/LaunchcastRounds.sol";
import {TestUSD} from "../contracts/TestUSD.sol";

interface VmR {
    function warp(uint256 timestamp) external;
    function prank(address caller) external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert(bytes4 revertData) external;
}

contract MockCurveR {
    address public token;
    bool public complete;
    uint128 public pairPrincipal;
    uint256 public targetPairUnits = 4 ether;
    uint256 public createdAt;
    constructor(address t, uint256 c) { token = t; createdAt = c; }
    function setPrincipal(uint128 p) external { pairPrincipal = p; }
    function setComplete(bool v) external { complete = v; }
}

contract MockTokenR { uint256 public x = 1; }

contract MockFactoryR {
    mapping(address => address) public curveOf;
    mapping(address => bool) public isV6Token;
    function add(address token, address curve) external { curveOf[token] = curve; isV6Token[token] = true; }
}

contract LaunchcastRoundsTest {
    VmR constant vm = VmR(address(uint160(uint256(keccak256("hevm cheat code")))));
    LaunchcastRounds rounds;
    TestUSD usd;
    MockFactoryR factory;
    MockCurveR curve;
    MockTokenR token;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new TestUSD();
        factory = new MockFactoryR();
        token = new MockTokenR();
        curve = new MockCurveR(address(token), block.timestamp - 1 hours);
        factory.add(address(token), address(curve));
        curve.setPrincipal(0.4 ether); // 10% progress
        rounds = new LaunchcastRounds(address(factory), address(usd));
        _fund(alice);
        _fund(bob);
    }

    function _fund(address u) internal {
        vm.prank(u); usd.faucet();
        vm.prank(u); usd.approve(address(rounds), type(uint256).max);
    }

    function testCreateSprintSnapshotsStrike() public {
        uint256 id = rounds.createRound(address(token), 0);
        LaunchcastRounds.Round memory r = rounds.getRound(id);
        require(r.strike == 0.44 ether, "strike = principal + 1% of target");
        require(r.endAt == block.timestamp + 300 && r.lockAt == r.endAt - 60, "times");
        require(r.startPrincipal == 0.4 ether, "start");
    }

    function testOneActiveRoundPerTokenTier() public {
        rounds.createRound(address(token), 0);
        vm.expectRevert(LaunchcastRounds.RoundActive.selector);
        rounds.createRound(address(token), 0);
        rounds.createRound(address(token), 1); // other tier fine
        vm.warp(block.timestamp + 301);
        rounds.createRound(address(token), 0); // allowed after end
    }

    function testStandardsRejectLowProgressOldAndGraduated() public {
        curve.setPrincipal(0.01 ether);
        vm.expectRevert(abi.encodeWithSelector(LaunchcastRounds.NotEligible.selector, uint8(5)));
        rounds.createRound(address(token), 0);
        curve.setPrincipal(0.39 ether);
        vm.expectRevert(abi.encodeWithSelector(LaunchcastRounds.NotEligible.selector, uint8(5)));
        rounds.createRound(address(token), 2); // graduation tier needs 10%
        curve.setPrincipal(0.4 ether);
        rounds.createRound(address(token), 2);
    }

    function testUnknownTokenRejected() public {
        vm.expectRevert(abi.encodeWithSelector(LaunchcastRounds.NotEligible.selector, uint8(1)));
        rounds.createRound(address(usd), 0);
    }

    function testTooOldRejected() public {
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(abi.encodeWithSelector(LaunchcastRounds.NotEligible.selector, uint8(4)));
        rounds.createRound(address(token), 0);
    }

    function testGraduatedRejected() public {
        curve.setComplete(true);
        vm.expectRevert(abi.encodeWithSelector(LaunchcastRounds.NotEligible.selector, uint8(3)));
        rounds.createRound(address(token), 0);
    }

    function testYesWinsWhenTouchProvenBeforeEnd() public {
        uint256 id = rounds.createRound(address(token), 0);
        vm.prank(alice); rounds.placeBet(id, true, 100e6);
        vm.prank(bob); rounds.placeBet(id, false, 300e6);
        curve.setPrincipal(0.45 ether);
        vm.expectRevert(LaunchcastRounds.AlreadyTouched.selector);
        vm.prank(bob); rounds.placeBet(id, false, 1e6);
        rounds.proveTouch(id);
        require(rounds.claimable(id, alice) == 400e6, "alice takes pool");
        require(rounds.claimable(id, bob) == 0, "bob lost");
        uint256 before = usd.balanceOf(alice);
        vm.prank(alice); rounds.claim(id);
        require(usd.balanceOf(alice) == before + 400e6, "paid");
        vm.expectRevert(LaunchcastRounds.NothingToClaim.selector);
        vm.prank(alice); rounds.claim(id);
    }

    function testNoWinsAfterEndWithoutProof() public {
        uint256 id = rounds.createRound(address(token), 0);
        vm.prank(alice); rounds.placeBet(id, true, 100e6);
        vm.prank(bob); rounds.placeBet(id, false, 100e6);
        vm.warp(block.timestamp + 250);
        vm.expectRevert(LaunchcastRounds.BettingClosed.selector);
        vm.prank(alice); rounds.placeBet(id, true, 1e6);
        vm.expectRevert(LaunchcastRounds.TooEarly.selector);
        rounds.resolve(id);
        vm.warp(block.timestamp + 51);
        curve.setPrincipal(0.5 ether); // touched only after the end: does not count
        vm.expectRevert(LaunchcastRounds.TooLate.selector);
        rounds.proveTouch(id);
        rounds.resolve(id);
        require(rounds.claimable(id, bob) == 200e6, "bob wins");
    }

    function testGraduationCountsAsTouch() public {
        uint256 id = rounds.createRound(address(token), 0);
        vm.prank(alice); rounds.placeBet(id, true, 10e6);
        curve.setPrincipal(0);
        curve.setComplete(true);
        rounds.proveTouch(id);
        require(rounds.claimable(id, alice) == 10e6, "stake back, no losers");
    }

    function testEmptyWinningSideVoidsAndRefunds() public {
        uint256 id = rounds.createRound(address(token), 0);
        vm.prank(alice); rounds.placeBet(id, true, 50e6);
        vm.warp(block.timestamp + 301);
        rounds.resolve(id);
        LaunchcastRounds.Round memory r = rounds.getRound(id);
        require(r.status == LaunchcastRounds.Status.Voided, "void");
        require(rounds.claimable(id, alice) == 50e6, "refund");
    }

    function testOnlyOwnerSetsBoundedStandards() public {
        vm.expectRevert(LaunchcastRounds.Unauthorized.selector);
        vm.prank(alice); rounds.setStandards(0, 100, 1 days);
        vm.expectRevert(LaunchcastRounds.InvalidTier.selector);
        rounds.setStandards(0, 9_500, 1 days);
        rounds.setStandards(0, 0, 1 days);
    }
}
