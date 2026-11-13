// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchcastFdvStake} from "../contracts/LaunchcastFdvStake.sol";
import {FFactory, FCurve, FToken, FLocker, FPoolManager} from "./LaunchcastFdv.t.sol";

interface VmS {
    function warp(uint256) external;
    function roll(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function envOr(string calldata, string calldata) external returns (string memory);
    function createSelectFork(string calldata) external returns (uint256);
    function addr(uint256) external returns (address);
}

interface IERC20S {
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// Stake token that skims a 2% fee on every transfer (fee-on-transfer).
contract TaxToken {
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external virtual returns (bool) { allowance[f][msg.sender] -= a; _move(f, to, a); return true; }
    function _move(address f, address to, uint256 a) internal { balanceOf[f] -= a; uint256 fee = a * 2 / 100; balanceOf[to] += a - fee; balanceOf[address(0xdead)] += fee; }
}

/// Stake token that also credits the receiver a bonus on transfer (reward-on-transfer quirk).
contract BonusToken is TaxToken {
    function _bonus(address to) internal { balanceOf[to] += 5e18; }
    function transferFrom(address f, address to, uint256 a) external override returns (bool) { allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; _bonus(to); return true; }
}

contract LaunchcastFdvStakeTest {
    VmS constant vm = VmS(address(uint160(uint256(keccak256("hevm cheat code")))));
    FFactory factory; FCurve curve; FToken token;
    address alice = address(0xA11CE); address bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_800_000_000); vm.roll(100);
        token = new FToken(); curve = new FCurve(address(token)); curve.set(0, 0);
        factory = new FFactory(address(new FLocker()), address(new FPoolManager())); factory.add(address(token), address(curve));
    }

    function _market(LaunchcastFdvStake s) internal returns (uint256 id) {
        (uint256 f,,,) = s.currentFdv(address(token));
        id = s.createMarket(address(token), f, uint64(block.timestamp + 100), uint64(block.timestamp + 200));
    }

    function testFeeOnTransferCreditsWhatArrivedAndStaysSolvent() public {
        TaxToken t = new TaxToken();
        LaunchcastFdvStake s = new LaunchcastFdvStake(address(factory), address(t), address(this));
        uint256 id = _market(s);
        t.mint(alice, 100e18); t.mint(bob, 100e18);
        vm.prank(alice); t.approve(address(s), type(uint256).max);
        vm.prank(bob); t.approve(address(s), type(uint256).max);
        vm.prank(alice); s.placeBet(id, true, 50e18);
        vm.prank(bob); s.placeBet(id, false, 50e18);
        require(s.yesStake(id, alice) == 49e18 && s.noStake(id, bob) == 49e18, "credited net of tax");
        LaunchcastFdvStake.Market memory m = s.getMarket(id);
        require(uint256(m.yesPool) + m.noPool == t.balanceOf(address(s)), "pools == balance");
        vm.warp(block.timestamp + 200);
        for (uint256 k; k < 3; k++) { s.observe(id); vm.warp(block.timestamp + 31); vm.roll(block.number + 1); }
        s.settle(id);
        require(s.claimable(id, alice) == 98e18, "YES (at threshold) takes both pools");
        vm.prank(alice); s.claim(id);
        require(t.balanceOf(address(s)) == 0, "fully paid out, no shortfall");
    }

    function testRewardOnTransferIsCappedAtRequestedAmount() public {
        BonusToken t = new BonusToken();
        LaunchcastFdvStake s = new LaunchcastFdvStake(address(factory), address(t), address(this));
        uint256 id = _market(s);
        t.mint(alice, 10e18);
        vm.prank(alice); t.approve(address(s), type(uint256).max);
        vm.prank(alice); s.placeBet(id, true, 10e18);
        require(s.yesStake(id, alice) == 10e18, "never credits the bonus");
        require(t.balanceOf(address(s)) >= 10e18, "solvent");
    }

    // ---------------------------------------------------------------- live fork checks with real V6 tokens
    // Run with: FORK_RPC=https://rpc.testnet.chain.robinhood.com forge test --match-contract LaunchcastFdvStake -vv
    address constant FACTORY = 0xac135dA186de8325047eF2AfD1d16D5971F731f7;
    address constant CAST = 0x23a1fCd0fd08a2868499C2DC695C6AcDC0B2Eeb9;
    address constant CAST_HOLDER = 0xC4a6C632A5090f241c43d1d21CA382a95Eb42dA1;
    address constant VIBEGOLD = 0x05A4813CD56666c80548A99f9102A0cf7d21Cc73; // graduated V6 token
    address constant VIBEGOLD_HOLDER = 0xbd48123F04d831aEC0eE68772A18457a7c372267;
    address constant CAST_OWNER = 0x54032f2d6aDc9b327F5f2222D5AE1d6346a2Cb14;

    /// $CAST graduated on Nov 13, 2026: transfers are unlocked, so $CAST works as the stake token end to end.
    function testForkCastStakeFullLifecycleAfterGraduation() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        LaunchcastFdvStake s = new LaunchcastFdvStake(FACTORY, CAST, address(this));
        (uint256 f, bool g,,) = s.currentFdv(CAST);
        require(f > 0 && g, "CAST graduated, FDV read from its v4 pool");
        uint256 id = s.createMarket(CAST, f, uint64(block.timestamp + 60), uint64(block.timestamp + 120));
        address u2 = vm.addr(9);
        vm.prank(CAST_OWNER); IERC20S(CAST).transfer(u2, 1000e18);
        vm.prank(CAST_OWNER); IERC20S(CAST).approve(address(s), type(uint256).max);
        vm.prank(u2); IERC20S(CAST).approve(address(s), type(uint256).max);
        vm.prank(CAST_OWNER); s.placeBet(id, true, 1000e18);
        vm.prank(u2); s.placeBet(id, false, 500e18);
        LaunchcastFdvStake.Market memory m = s.getMarket(id);
        require(uint256(m.yesPool) + m.noPool <= IERC20S(CAST).balanceOf(address(s)), "solvent");
        vm.warp(block.timestamp + 120);
        for (uint256 k; k < 3; k++) { s.observe(id); vm.warp(block.timestamp + 31); vm.roll(block.number + 1); }
        s.settle(id);
        uint256 owed = s.claimable(id, CAST_OWNER);
        require(owed == uint256(m.yesPool) + m.noPool, "YES (FDV unchanged = at threshold) takes both pools");
        uint256 before = IERC20S(CAST).balanceOf(CAST_OWNER);
        vm.prank(CAST_OWNER); s.claim(id);
        require(IERC20S(CAST).balanceOf(CAST_OWNER) >= before + owed - owed / 100, "paid");
    }

    function testForkGraduatedV6TokenAsStakeFullLifecycle() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        LaunchcastFdvStake s = new LaunchcastFdvStake(FACTORY, VIBEGOLD, address(this));
        (uint256 f,,,) = s.currentFdv(CAST);
        uint256 id = s.createMarket(CAST, f, uint64(block.timestamp + 60), uint64(block.timestamp + 120));
        address u2 = vm.addr(9);
        vm.prank(VIBEGOLD_HOLDER); IERC20S(VIBEGOLD).transfer(u2, 100e18);
        vm.prank(VIBEGOLD_HOLDER); IERC20S(VIBEGOLD).approve(address(s), type(uint256).max);
        vm.prank(u2); IERC20S(VIBEGOLD).approve(address(s), type(uint256).max);
        vm.prank(VIBEGOLD_HOLDER); s.placeBet(id, true, 100e18);
        vm.prank(u2); s.placeBet(id, false, 50e18);
        LaunchcastFdvStake.Market memory m = s.getMarket(id);
        require(uint256(m.yesPool) + m.noPool <= IERC20S(VIBEGOLD).balanceOf(address(s)), "solvent");
        vm.warp(block.timestamp + 120);
        for (uint256 k; k < 3; k++) { s.observe(id); vm.warp(block.timestamp + 31); vm.roll(block.number + 1); }
        s.settle(id);
        uint256 owed = s.claimable(id, VIBEGOLD_HOLDER);
        require(owed == uint256(m.yesPool) + m.noPool, "YES (FDV unchanged = at threshold) takes both pools");
        uint256 before = IERC20S(VIBEGOLD).balanceOf(VIBEGOLD_HOLDER);
        vm.prank(VIBEGOLD_HOLDER); s.claim(id);
        require(IERC20S(VIBEGOLD).balanceOf(VIBEGOLD_HOLDER) >= before + owed, "paid");
    }
}
