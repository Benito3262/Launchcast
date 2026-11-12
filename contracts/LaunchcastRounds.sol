// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVibeV6Factory {
    function isV6Token(address token) external view returns (bool);
    function curveOf(address token) external view returns (address);
}

interface IVibeV6Curve {
    function token() external view returns (address);
    function complete() external view returns (bool);
    function pairPrincipal() external view returns (uint128);
    function targetPairUnits() external view returns (uint256);
    function createdAt() external view returns (uint256);
}

interface IERC20Rounds {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title LaunchcastRounds (LaunchCast V2 live rounds)
/// @notice Permissionless, short YES/NO rounds on VibeVibe V6 bonding curves, settled entirely from on-chain curve state.
/// @dev A round asks: "Will this curve's pair principal reach `strike` before `endAt`?"
///      YES is proven by anyone calling `proveTouch` while the curve is at/above the strike (or complete) before `endAt`.
///      After `endAt`, anyone can call `resolve` and an unproven round settles NO. If the winning side is empty, the round
///      is voided and every stake is refundable. Testnet only. Stakes are TestUSD with no real value. No fees.
contract LaunchcastRounds {
    error Unauthorized();
    error InvalidAddress();
    error InvalidTier();
    error NotEligible(uint8 reason);
    error RoundActive();
    error InvalidRound();
    error BettingClosed();
    error AlreadyTouched();
    error NotTouched();
    error TooEarly();
    error TooLate();
    error InvalidAmount();
    error NothingToClaim();
    error TransferFailed();
    error ReentrantCall();

    // NotEligible reasons
    uint8 public constant REASON_NOT_V6 = 1;
    uint8 public constant REASON_CURVE_MISMATCH = 2;
    uint8 public constant REASON_GRADUATED = 3;
    uint8 public constant REASON_TOO_OLD = 4;
    uint8 public constant REASON_LOW_PROGRESS = 5;
    uint8 public constant REASON_STRIKE_REACHED = 6;

    enum Status {
        Open,
        ResolvedYes,
        ResolvedNo,
        Voided
    }

    struct Tier {
        uint64 duration; // seconds
        uint64 lockBefore; // betting closes this many seconds before endAt
        uint16 stepBps; // strike = startPrincipal + target * stepBps / 10_000 (10_000 = graduation)
        uint16 minProgressBps; // minimum curve progress to open a round
        uint64 maxAge; // maximum curve age in seconds
    }

    struct Round {
        address token;
        address curve;
        address creator;
        uint8 tier;
        Status status;
        uint64 startAt;
        uint64 lockAt;
        uint64 endAt;
        uint128 startPrincipal;
        uint128 strike;
        uint256 target;
        uint128 yesPool;
        uint128 noPool;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_STAKE = type(uint128).max;

    IVibeV6Factory public immutable factory;
    IERC20Rounds public immutable stakeToken;
    address public owner;
    uint256 public roundCount;
    Tier[3] public tiers;

    mapping(uint256 => Round) private rounds;
    mapping(address => mapping(uint8 => uint256)) public latestRound; // token => tier => round id
    mapping(uint256 => mapping(address => uint256)) public yesStake;
    mapping(uint256 => mapping(address => uint256)) public noStake;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;
    uint256 private lockState = 1;

    event RoundCreated(
        uint256 indexed roundId,
        address indexed token,
        uint8 indexed tier,
        address curve,
        address creator,
        uint64 lockAt,
        uint64 endAt,
        uint128 startPrincipal,
        uint128 strike,
        uint256 target
    );
    event BetPlaced(uint256 indexed roundId, address indexed user, bool indexed sideYes, uint256 amount);
    event RoundResolved(uint256 indexed roundId, Status status, uint128 observedPrincipal, address indexed caller);
    event Claimed(uint256 indexed roundId, address indexed user, uint256 payout);
    event TierUpdated(uint8 indexed tier, uint16 minProgressBps, uint64 maxAge);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier nonReentrant() {
        if (lockState != 1) revert ReentrantCall();
        lockState = 2;
        _;
        lockState = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address factory_, address stakeToken_) {
        if (factory_.code.length == 0 || stakeToken_.code.length == 0) revert InvalidAddress();
        factory = IVibeV6Factory(factory_);
        stakeToken = IERC20Rounds(stakeToken_);
        owner = msg.sender;
        // Sprint: 5 minutes, +1% of the graduation target, bets lock 60s before the end.
        tiers[0] = Tier({duration: 5 minutes, lockBefore: 60, stepBps: 100, minProgressBps: 200, maxAge: 7 days});
        // Climb: 1 hour, +5% of the graduation target, bets lock 10 minutes before the end.
        tiers[1] = Tier({duration: 1 hours, lockBefore: 10 minutes, stepBps: 500, minProgressBps: 200, maxAge: 7 days});
        // Graduation: 24 hours, strike = full target (or curve complete), bets lock 1 hour before the end.
        tiers[2] = Tier({duration: 24 hours, lockBefore: 1 hours, stepBps: 10_000, minProgressBps: 1_000, maxAge: 14 days});
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------- views

    function getRound(uint256 roundId) external view returns (Round memory) {
        if (roundId == 0 || roundId > roundCount) revert InvalidRound();
        return rounds[roundId];
    }

    function getTier(uint8 tier) external view returns (Tier memory) {
        if (tier > 2) revert InvalidTier();
        return tiers[tier];
    }

    /// @notice Whether a round's strike is met right now (curve principal >= strike, or curve complete).
    function isTouched(uint256 roundId) public view returns (bool) {
        Round storage r = _round(roundId);
        return _touched(r.curve, r.strike);
    }

    /// @notice Eligibility check used by `createRound`. Returns 0 when eligible, otherwise a NotEligible reason code.
    function eligibility(address token, uint8 tier)
        public
        view
        returns (uint8 reason, address curve, uint128 principal, uint128 strike, uint256 target)
    {
        if (tier > 2) revert InvalidTier();
        Tier memory t = tiers[tier];
        if (token.code.length == 0 || !factory.isV6Token(token)) return (REASON_NOT_V6, address(0), 0, 0, 0);
        curve = factory.curveOf(token);
        if (curve.code.length == 0 || IVibeV6Curve(curve).token() != token) return (REASON_CURVE_MISMATCH, curve, 0, 0, 0);
        if (IVibeV6Curve(curve).complete()) return (REASON_GRADUATED, curve, 0, 0, 0);
        uint256 created = IVibeV6Curve(curve).createdAt();
        if (created > block.timestamp || block.timestamp - created > t.maxAge) return (REASON_TOO_OLD, curve, 0, 0, 0);
        target = IVibeV6Curve(curve).targetPairUnits();
        principal = IVibeV6Curve(curve).pairPrincipal();
        if (target == 0 || uint256(principal) * BPS < target * t.minProgressBps) {
            return (REASON_LOW_PROGRESS, curve, principal, 0, target);
        }
        uint256 s = t.stepBps >= BPS ? target : uint256(principal) + (target * t.stepBps) / BPS;
        if (s > target) s = target;
        strike = uint128(s);
        if (principal >= strike) return (REASON_STRIKE_REACHED, curve, principal, strike, target);
        return (0, curve, principal, strike, target);
    }

    function claimable(uint256 roundId, address user) public view returns (uint256) {
        Round storage r = _round(roundId);
        if (hasClaimed[roundId][user]) return 0;
        uint256 y = yesStake[roundId][user];
        uint256 n = noStake[roundId][user];
        if (r.status == Status.Voided) return y + n;
        if (r.status == Status.ResolvedYes) return y == 0 ? 0 : y + (uint256(r.noPool) * y) / r.yesPool;
        if (r.status == Status.ResolvedNo) return n == 0 ? 0 : n + (uint256(r.yesPool) * n) / r.noPool;
        return 0;
    }

    // ---------------------------------------------------------------- actions

    /// @notice Open a round for a VibeVibe V6 token. Anyone can call this; on-chain standards decide eligibility.
    function createRound(address token, uint8 tier) external nonReentrant returns (uint256 roundId) {
        (uint8 reason, address curve, uint128 principal, uint128 strike, uint256 target) = eligibility(token, tier);
        if (reason != 0) revert NotEligible(reason);
        uint256 prev = latestRound[token][tier];
        if (prev != 0 && rounds[prev].endAt > block.timestamp) revert RoundActive();

        Tier memory t = tiers[tier];
        roundId = ++roundCount;
        Round storage r = rounds[roundId];
        r.token = token;
        r.curve = curve;
        r.creator = msg.sender;
        r.tier = tier;
        r.status = Status.Open;
        r.startAt = uint64(block.timestamp);
        r.endAt = uint64(block.timestamp + t.duration);
        r.lockAt = r.endAt - t.lockBefore;
        r.startPrincipal = principal;
        r.strike = strike;
        r.target = target;
        latestRound[token][tier] = roundId;
        emit RoundCreated(roundId, token, tier, curve, msg.sender, r.lockAt, r.endAt, principal, strike, target);
    }

    function placeBet(uint256 roundId, bool sideYes, uint256 amount) external nonReentrant {
        Round storage r = _round(roundId);
        if (r.status != Status.Open || block.timestamp >= r.lockAt) revert BettingClosed();
        if (_touched(r.curve, r.strike)) revert AlreadyTouched();
        if (amount == 0) revert InvalidAmount();
        if (sideYes) {
            uint256 next = uint256(r.yesPool) + amount;
            if (next > MAX_STAKE) revert InvalidAmount();
            r.yesPool = uint128(next);
            yesStake[roundId][msg.sender] += amount;
        } else {
            uint256 next = uint256(r.noPool) + amount;
            if (next > MAX_STAKE) revert InvalidAmount();
            r.noPool = uint128(next);
            noStake[roundId][msg.sender] += amount;
        }
        if (!stakeToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit BetPlaced(roundId, msg.sender, sideYes, amount);
    }

    /// @notice Settle YES: callable by anyone, at any time before `endAt`, while the strike is met on-chain.
    function proveTouch(uint256 roundId) external nonReentrant {
        Round storage r = _round(roundId);
        if (r.status != Status.Open) revert InvalidRound();
        if (block.timestamp > r.endAt) revert TooLate();
        if (!_touched(r.curve, r.strike)) revert NotTouched();
        r.status = r.yesPool == 0 ? Status.Voided : Status.ResolvedYes;
        emit RoundResolved(roundId, r.status, IVibeV6Curve(r.curve).pairPrincipal(), msg.sender);
    }

    /// @notice Settle NO: callable by anyone after `endAt` when no touch was proven in time.
    function resolve(uint256 roundId) external nonReentrant {
        Round storage r = _round(roundId);
        if (r.status != Status.Open) revert InvalidRound();
        if (block.timestamp <= r.endAt) revert TooEarly();
        r.status = r.noPool == 0 ? Status.Voided : Status.ResolvedNo;
        emit RoundResolved(roundId, r.status, IVibeV6Curve(r.curve).pairPrincipal(), msg.sender);
    }

    function claim(uint256 roundId) external nonReentrant returns (uint256 payout) {
        payout = claimable(roundId, msg.sender);
        if (payout == 0) revert NothingToClaim();
        hasClaimed[roundId][msg.sender] = true;
        if (!stakeToken.transfer(msg.sender, payout)) revert TransferFailed();
        emit Claimed(roundId, msg.sender, payout);
    }

    // ---------------------------------------------------------------- owner (standards only; cannot touch stakes)

    function setStandards(uint8 tier, uint16 minProgressBps, uint64 maxAge) external onlyOwner {
        if (tier > 2 || minProgressBps > 9_000 || maxAge < 1 hours || maxAge > 60 days) revert InvalidTier();
        tiers[tier].minProgressBps = minProgressBps;
        tiers[tier].maxAge = maxAge;
        emit TierUpdated(tier, minProgressBps, maxAge);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------------------------------------------------------- internal

    function _round(uint256 roundId) private view returns (Round storage) {
        if (roundId == 0 || roundId > roundCount) revert InvalidRound();
        return rounds[roundId];
    }

    function _touched(address curve, uint128 strike) private view returns (bool) {
        return IVibeV6Curve(curve).complete() || IVibeV6Curve(curve).pairPrincipal() >= strike;
    }
}
