// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVibeV6FactoryFdv {
    function isV6Token(address token) external view returns (bool);
    function curveOf(address token) external view returns (address);
    function locker() external view returns (address);
    function poolManager() external view returns (address);
}

interface IVibeV6CurveFdv {
    function token() external view returns (address);
    function complete() external view returns (bool);
    function pairCurrency() external view returns (address);
    function sold() external view returns (uint120);
    function pairPrincipal() external view returns (uint128);
    function targetPairUnits() external view returns (uint256);
}

interface IVibeV6LockerFdv {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function poolKeyOf(address token) external view returns (PoolKey memory);
}

interface IPoolManagerExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IERC20Fdv {
    function totalSupply() external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title LaunchcastFdv
/// @notice YES/NO markets on "Will TOKEN's FDV be at or above X (in its pair asset) at time T?" for any VibeVibe V6
///         launch: any age, graduated or still on its bonding curve, any pair (ETH, stock tokens, VIBEVIBE...).
/// @dev Settlement is read directly from chain state, with no resolver key:
///      - Bonding curve (not graduated): V6 curves are constant product with virtual reserves
///        (target/3 + principal) * (3200e24/3 - sold) = const, so FDV = (target + 3*principal) * supply / (3200e24 - 3*sold).
///        The observation reverts if the curve doesn't match that shape (1% tolerance).
///      - Graduated: spot price from the locked Uniswap v4 pool's slot0 (sqrtPriceX96) via PoolManager.extsload,
///        FDV = price * totalSupply.
///      Manipulation guard: spot reads can be pushed inside one transaction, so the outcome is the median of up to
///      three observations that anyone can record during [observeAt, observeAt + OBSERVATION_WINDOW], each in a
///      different block and at least MIN_SPACING seconds after the previous one. No observation => refund.
///      Testnet only. TestUSD stakes have no value. 0% fee.
contract LaunchcastFdv {
    error Unauthorized();
    error InvalidAddress();
    error InvalidMarket();
    error InvalidTime();
    error InvalidAmount();
    error BettingClosed();
    error NotObservable();
    error TooSoon();
    error NotReady();
    error BadCurveShape();
    error PoolUnavailable();
    error NothingToClaim();
    error TransferFailed();
    error ReentrantCall();

    enum Status {
        Open,
        Resolved,
        Voided
    }

    struct Market {
        address token;
        address curve;
        address pairCurrency;
        uint64 closeAt;
        uint64 observeAt;
        Status status;
        bool outcomeYes;
        uint8 obsCount;
        uint64 lastObsTime;
        uint64 lastObsBlock;
        uint256 thresholdFdv; // pair-asset raw units (pair decimals)
        uint256 fdvAtCreation;
        uint256[3] obs;
        uint256 settledFdv;
        uint128 yesPool;
        uint128 noPool;
    }

    uint256 public constant CURVE_SUPPLY_X3 = 3200e24; // 3 * (800M * 4/3) virtual tokens, 18 decimals
    uint64 public constant OBSERVATION_WINDOW = 1 hours;
    uint64 public constant MIN_SPACING = 30;
    uint256 public constant POOLS_SLOT = 6;
    uint256 public constant MAX_STAKE = type(uint128).max;

    IVibeV6FactoryFdv public immutable factory;
    IERC20Fdv public immutable stakeToken;
    address public owner;
    uint256 public marketCount;
    uint256 private lockState = 1;

    mapping(uint256 => Market) private markets;
    mapping(uint256 => mapping(address => uint256)) public yesStake;
    mapping(uint256 => mapping(address => uint256)) public noStake;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    event MarketCreated(
        uint256 indexed marketId, address indexed token, address curve, address pairCurrency,
        uint256 thresholdFdv, uint64 closeAt, uint64 observeAt, uint256 fdvAtCreation
    );
    event BetPlaced(uint256 indexed marketId, address indexed user, bool indexed sideYes, uint256 amount);
    event Observed(uint256 indexed marketId, uint8 index, uint256 fdv, bool graduated, address indexed caller);
    event MarketSettled(uint256 indexed marketId, Status status, bool outcomeYes, uint256 medianFdv);
    event Claimed(uint256 indexed marketId, address indexed user, uint256 payout);
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

    constructor(address factory_, address stakeToken_, address owner_) {
        if (factory_.code.length == 0 || stakeToken_.code.length == 0 || owner_ == address(0)) revert InvalidAddress();
        factory = IVibeV6FactoryFdv(factory_);
        stakeToken = IERC20Fdv(stakeToken_);
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ------------------------------------------------------------------ views

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return _market(marketId);
    }

    /// @notice Current FDV of a V6 token in its pair asset's raw units, plus whether it has graduated.
    function currentFdv(address token) public view returns (uint256 fdv, bool graduated, address curve, address pair) {
        if (token.code.length == 0 || !factory.isV6Token(token)) revert InvalidAddress();
        curve = factory.curveOf(token);
        if (curve.code.length == 0 || IVibeV6CurveFdv(curve).token() != token) revert InvalidAddress();
        pair = IVibeV6CurveFdv(curve).pairCurrency();
        (fdv, graduated) = _fdv(token, curve);
    }

    function claimable(uint256 marketId, address user) public view returns (uint256) {
        Market storage m = _market(marketId);
        if (hasClaimed[marketId][user]) return 0;
        uint256 y = yesStake[marketId][user];
        uint256 n = noStake[marketId][user];
        if (m.status == Status.Voided) return y + n;
        if (m.status != Status.Resolved) return 0;
        if (m.outcomeYes) return y == 0 ? 0 : y + (uint256(m.noPool) * y) / m.yesPool;
        return n == 0 ? 0 : n + (uint256(m.yesPool) * n) / m.noPool;
    }

    // ------------------------------------------------------------------ actions

    function createMarket(address token, uint256 thresholdFdv, uint64 closeAt, uint64 observeAt)
        external
        nonReentrant
        onlyOwner
        returns (uint256 marketId)
    {
        if (thresholdFdv == 0) revert InvalidMarket();
        if (closeAt <= block.timestamp || observeAt < closeAt || observeAt > block.timestamp + 365 days) revert InvalidTime();
        (uint256 fdvNow,, address curve, address pair) = currentFdv(token);
        marketId = ++marketCount;
        Market storage m = markets[marketId];
        m.token = token;
        m.curve = curve;
        m.pairCurrency = pair;
        m.closeAt = closeAt;
        m.observeAt = observeAt;
        m.thresholdFdv = thresholdFdv;
        m.fdvAtCreation = fdvNow;
        emit MarketCreated(marketId, token, curve, pair, thresholdFdv, closeAt, observeAt, fdvNow);
    }

    function placeBet(uint256 marketId, bool sideYes, uint256 amount) external nonReentrant {
        Market storage m = _market(marketId);
        if (m.status != Status.Open || block.timestamp >= m.closeAt) revert BettingClosed();
        if (amount == 0) revert InvalidAmount();
        if (sideYes) {
            uint256 next = uint256(m.yesPool) + amount;
            if (next > MAX_STAKE) revert InvalidAmount();
            m.yesPool = uint128(next);
            yesStake[marketId][msg.sender] += amount;
        } else {
            uint256 next = uint256(m.noPool) + amount;
            if (next > MAX_STAKE) revert InvalidAmount();
            m.noPool = uint128(next);
            noStake[marketId][msg.sender] += amount;
        }
        if (!stakeToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit BetPlaced(marketId, msg.sender, sideYes, amount);
    }

    /// @notice Record one FDV observation from live chain state. Anyone can call during the observation window.
    function observe(uint256 marketId) external nonReentrant {
        Market storage m = _market(marketId);
        if (m.status != Status.Open || m.obsCount >= 3) revert NotObservable();
        if (block.timestamp < m.observeAt || block.timestamp > uint256(m.observeAt) + OBSERVATION_WINDOW) {
            revert NotObservable();
        }
        if (m.obsCount > 0 && (block.number <= m.lastObsBlock || block.timestamp < uint256(m.lastObsTime) + MIN_SPACING)) {
            revert TooSoon();
        }
        (uint256 fdv, bool graduated) = _fdv(m.token, m.curve);
        m.obs[m.obsCount] = fdv;
        m.lastObsTime = uint64(block.timestamp);
        m.lastObsBlock = uint64(block.number);
        emit Observed(marketId, m.obsCount, fdv, graduated, msg.sender);
        m.obsCount += 1;
    }

    /// @notice Settle once three observations exist, or after the observation window closes.
    function settle(uint256 marketId) external nonReentrant {
        Market storage m = _market(marketId);
        if (m.status != Status.Open) revert InvalidMarket();
        if (m.obsCount < 3 && block.timestamp <= uint256(m.observeAt) + OBSERVATION_WINDOW) revert NotReady();
        if (m.obsCount == 0) {
            m.status = Status.Voided;
            emit MarketSettled(marketId, Status.Voided, false, 0);
            return;
        }
        uint256 med = _median(m.obs, m.obsCount);
        bool yes = med >= m.thresholdFdv;
        m.settledFdv = med;
        m.outcomeYes = yes;
        m.status = (yes ? m.yesPool : m.noPool) == 0 ? Status.Voided : Status.Resolved;
        emit MarketSettled(marketId, m.status, yes, med);
    }

    function claim(uint256 marketId) external nonReentrant returns (uint256 payout) {
        payout = claimable(marketId, msg.sender);
        if (payout == 0) revert NothingToClaim();
        hasClaimed[marketId][msg.sender] = true;
        if (!stakeToken.transfer(msg.sender, payout)) revert TransferFailed();
        emit Claimed(marketId, msg.sender, payout);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------------ internal

    function _market(uint256 marketId) private view returns (Market storage) {
        if (marketId == 0 || marketId > marketCount) revert InvalidMarket();
        return markets[marketId];
    }

    function _fdv(address token, address curve) private view returns (uint256 fdv, bool graduated) {
        uint256 supply = IERC20Fdv(token).totalSupply();
        graduated = IVibeV6CurveFdv(curve).complete();
        if (!graduated) {
            uint256 target = IVibeV6CurveFdv(curve).targetPairUnits();
            uint256 principal = IVibeV6CurveFdv(curve).pairPrincipal();
            uint256 sold3 = uint256(IVibeV6CurveFdv(curve).sold()) * 3;
            if (target == 0 || sold3 >= CURVE_SUPPLY_X3) revert BadCurveShape();
            uint256 numer = target + 3 * principal;
            uint256 denom = CURVE_SUPPLY_X3 - sold3;
            // Shape check: (target + 3P) * (3Tv - 3s) must equal target * 3Tv within 1%.
            uint256 lhs = _mulDiv(numer, denom, 1e18);
            uint256 rhs = _mulDiv(target, CURVE_SUPPLY_X3, 1e18);
            uint256 diff = lhs > rhs ? lhs - rhs : rhs - lhs;
            if (diff * 100 > rhs) revert BadCurveShape();
            fdv = _mulDiv(numer, supply, denom);
        } else {
            IVibeV6LockerFdv.PoolKey memory key = IVibeV6LockerFdv(factory.locker()).poolKeyOf(token);
            bool tokenIs0 = key.currency0 == token;
            if (!tokenIs0 && key.currency1 != token) revert PoolUnavailable();
            bytes32 poolId = keccak256(abi.encode(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks));
            bytes32 word = IPoolManagerExtsload(factory.poolManager()).extsload(keccak256(abi.encode(poolId, POOLS_SLOT)));
            uint256 sqrtP = uint256(word) & ((1 << 160) - 1);
            if (sqrtP == 0) revert PoolUnavailable();
            uint256 q96 = 1 << 96;
            fdv = tokenIs0 ? _mulDiv(_mulDiv(supply, sqrtP, q96), sqrtP, q96) : _mulDiv(_mulDiv(supply, q96, sqrtP), q96, sqrtP);
        }
    }

    function _median(uint256[3] storage o, uint8 n) private view returns (uint256) {
        if (n == 1) return o[0];
        if (n == 2) return (o[0] + o[1]) / 2;
        uint256 a = o[0];
        uint256 b = o[1];
        uint256 c = o[2];
        if (a > b) (a, b) = (b, a);
        if (b > c) (b, c) = (c, b);
        if (a > b) (a, b) = (b, a);
        return b;
    }

    /// @dev Full-precision (a * b) / d, reverts on overflow of the result (Remco Bloemen / Uniswap FullMath).
    function _mulDiv(uint256 a, uint256 b, uint256 d) private pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) return prod0 / d;
            require(d > prod1, "mulDiv overflow");
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, d)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = d & (~d + 1);
            assembly {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            result = prod0 * inv;
        }
    }
}
