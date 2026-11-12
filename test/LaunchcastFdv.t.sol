// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchcastFdv, IVibeV6LockerFdv} from "../contracts/LaunchcastFdv.sol";
import {TestUSD} from "../contracts/TestUSD.sol";

interface VmF {
    function warp(uint256) external;
    function roll(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function envOr(string calldata, string calldata) external returns (string memory);
    function createSelectFork(string calldata) external returns (uint256);
    function addr(uint256) external returns (address);
}

contract FToken { uint256 public totalSupply = 1_000_000_000e18; }

contract FCurve {
    address public token; address public pairCurrency; bool public complete;
    uint120 public sold; uint128 public pairPrincipal; uint256 public targetPairUnits = 4 ether;
    constructor(address t) { token = t; }
    function set(uint120 s, uint128 p) external { sold = s; pairPrincipal = p; }
    function setComplete(bool c) external { complete = c; }
}

contract FLocker {
    IVibeV6LockerFdv.PoolKey k;
    function setKey(IVibeV6LockerFdv.PoolKey memory key) external { k = key; }
    function poolKeyOf(address) external view returns (IVibeV6LockerFdv.PoolKey memory) { return k; }
}

contract FPoolManager {
    bytes32 public word;
    function setWord(bytes32 w) external { word = w; }
    function extsload(bytes32) external view returns (bytes32) { return word; }
}

contract FFactory {
    mapping(address => address) public curveOf; mapping(address => bool) public isV6Token;
    address public locker; address public poolManager;
    constructor(address l, address p) { locker = l; poolManager = p; }
    function add(address t, address c) external { curveOf[t] = c; isV6Token[t] = true; }
}

contract LaunchcastFdvTest {
    VmF constant vm = VmF(address(uint160(uint256(keccak256("hevm cheat code")))));
    LaunchcastFdv fdv; TestUSD usd; FFactory factory; FCurve curve; FToken token; FLocker locker; FPoolManager pm;
    address alice = address(0xA11CE); address bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_800_000_000); vm.roll(100);
        usd = new TestUSD(); token = new FToken(); curve = new FCurve(address(token));
        locker = new FLocker(); pm = new FPoolManager();
        factory = new FFactory(address(locker), address(pm)); factory.add(address(token), address(curve));
        fdv = new LaunchcastFdv(address(factory), address(usd), address(this));
        for (uint256 i; i < 2; i++) { address u = i == 0 ? alice : bob; vm.prank(u); usd.faucet(); vm.prank(u); usd.approve(address(fdv), type(uint256).max); }
    }

    function testCurveFdvMatchesConstantProduct() public {
        (uint256 f0,,,) = fdv.currentFdv(address(token));
        require(f0 == 1.25 ether, "launch FDV = 5/16 of target");
        // Halfway raised: P=2, sold s solves (4/3+2)(Tv-s)=(4/3)Tv => s = 0.6 Tv = 640M
        curve.set(640_000_000e18, 2 ether);
        (uint256 f1,,,) = fdv.currentFdv(address(token));
        require(f1 == 7.8125 ether, "mid FDV");
    }

    function testRejectsOffShapeCurve() public {
        curve.set(100_000_000e18, 3 ether);
        vm.expectRevert(LaunchcastFdv.BadCurveShape.selector);
        fdv.currentFdv(address(token));
    }

    function testGraduatedReadsV4Pool() public {
        curve.setComplete(true);
        // token is currency1 (ETH = address(0) is currency0). price(token in ETH) = 1/(sqrtP/2^96)^2.
        locker.setKey(IVibeV6LockerFdv.PoolKey(address(0), address(token), 0, 60, address(0)));
        // sqrtP = 2^96 * 10000 => token price = 1e-8 ETH => FDV = 10 ETH
        pm.setWord(bytes32(uint256(2 ** 96 * 10000)));
        (uint256 f, bool g,,) = fdv.currentFdv(address(token));
        require(g && f == 10 ether, "pool FDV");
    }

    function _create(uint256 threshold) internal returns (uint256) {
        return fdv.createMarket(address(token), threshold, uint64(block.timestamp + 1 hours), uint64(block.timestamp + 2 hours));
    }

    function testOnlyOwnerCreates() public {
        vm.prank(alice); vm.expectRevert(LaunchcastFdv.Unauthorized.selector); _create(2 ether);
    }

    function testFullLifecycleMedianOfThree() public {
        uint256 id = _create(5 ether);
        vm.prank(alice); fdv.placeBet(id, true, 100e6);
        vm.prank(bob); fdv.placeBet(id, false, 300e6);
        vm.expectRevert(LaunchcastFdv.NotObservable.selector); fdv.observe(id);
        vm.warp(block.timestamp + 2 hours);
        curve.set(640_000_000e18, 2 ether); // 7.8125
        fdv.observe(id);
        vm.expectRevert(LaunchcastFdv.TooSoon.selector); fdv.observe(id);
        vm.warp(block.timestamp + 31); vm.roll(block.number + 1);
        curve.set(0, 0); // 1.25 (a spike down in one block)
        fdv.observe(id);
        vm.warp(block.timestamp + 31); vm.roll(block.number + 1);
        curve.set(640_000_000e18, 2 ether);
        fdv.observe(id);
        fdv.settle(id);
        LaunchcastFdv.Market memory m = fdv.getMarket(id);
        require(m.outcomeYes && m.settledFdv == 7.8125 ether, "median ignores outlier");
        require(fdv.claimable(id, alice) == 400e6 && fdv.claimable(id, bob) == 0, "payouts");
        vm.prank(alice); fdv.claim(id);
        require(usd.balanceOf(alice) == 10_000e6 + 300e6, "paid");
    }

    function testNoObservationVoidsAndRefunds() public {
        uint256 id = _create(5 ether);
        vm.prank(alice); fdv.placeBet(id, true, 50e6);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(LaunchcastFdv.NotReady.selector); fdv.settle(id);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(LaunchcastFdv.NotObservable.selector); fdv.observe(id);
        fdv.settle(id);
        require(fdv.claimable(id, alice) == 50e6, "refund");
    }

    function testBettingClosesAtCloseAt() public {
        uint256 id = _create(5 ether);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice); vm.expectRevert(LaunchcastFdv.BettingClosed.selector); fdv.placeBet(id, true, 1e6);
    }

    // ---------------------------------------------------------------- live fork checks
    // Run with: FORK_RPC=https://rpc.testnet.chain.robinhood.com forge test --match-test testFork -vv
    address constant FACTORY = 0xac135dA186de8325047eF2AfD1d16D5971F731f7;
    address constant TUSD = 0x9557AaDe5C89fE39941b4f3a60CbAC16E3f32143;

    function testForkRealTokens() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        LaunchcastFdv live = new LaunchcastFdv(FACTORY, TUSD, address(this));
        address[9] memory toks = [
            0xfe42C4067550916EC7328D844cf1675aA405eE0F, // DISTR, graduated, ETH
            0x2A9F3D3d8E5Bb7B39fBFb2826833693Be5daca38, // VIBEVIBEFINAL, launch #0, graduated, ETH
            0x05A4813CD56666c80548A99f9102A0cf7d21Cc73, // VIBEGOLD, graduated, VIBEVIBE pair
            0xF8A641160423A8B4B1531DAD4A15a805E2a69d2f, // DSDF, graduated, stock pair
            0xF4dC5b92D9bE7af2d041bF4fBCAc746A6b8e3A98, // FUNK, graduated, other pair
            0xe9dAde5868ea9762627FbA9c5F1a81F8B83aeca6, // PEEKI, on curve, ETH
            0xad7582F7FeEE41557B1D32534F96046bC50875dd, // launch #343, 5 days old, on curve, ETH
            0xEE6DEDc1C43C3023FDB6917f13DB9Fcd4BaE8006, // VVB, on curve, non-ETH
            0x9770E0B7DD5C1E54e909DdC42E07bb2Ef31ae8F5  // META, on curve at ~98%, VIBEVIBE pair
        ];
        for (uint256 i; i < toks.length; i++) {
            (uint256 f, bool g,,) = live.currentFdv(toks[i]);
            require(f > 0, "fdv");
            emit log_fdv(toks[i], f, g);
        }
        // full lifecycle on a real graduated, stock-paired token
        (uint256 now0,,,) = live.currentFdv(toks[3]);
        uint256 id = live.createMarket(toks[3], now0, uint64(block.timestamp + 60), uint64(block.timestamp + 120));
        address u = vm.addr(7);
        vm.prank(u); TestUSD(TUSD).faucet();
        vm.prank(u); TestUSD(TUSD).approve(address(live), type(uint256).max);
        vm.prank(u); live.placeBet(id, true, 10e6);
        vm.warp(block.timestamp + 120);
        for (uint256 k; k < 3; k++) { live.observe(id); vm.warp(block.timestamp + 31); vm.roll(block.number + 1); }
        live.settle(id);
        LaunchcastFdv.Market memory m = live.getMarket(id);
        require(m.settledFdv == now0, "unchanged state settles at the same FDV");
        require(m.status == LaunchcastFdv.Status.Resolved && m.outcomeYes, "at threshold => YES");
        require(live.claimable(id, u) == 10e6, "winner gets stake back when NO side is empty");
    }

    event log_fdv(address token, uint256 fdv, bool graduated);
}
