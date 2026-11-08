// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 interface used by Launchcast.
interface IVibeVibeCurveIdentity { function token() external view returns (address); }
interface IVibeVibeTokenIdentity { function curve() external view returns (address); }

interface IERC20Launchcast {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Launchcast
/// @notice Testnet-first YES/NO pooled markets whose result is read from a VibeVibe curve.
/// @dev Market outcome means the curve's graduated() state when settlement is executed
///      at or after resolveAfter. It does not prove the time at which graduation occurred.
contract Launchcast {
    error Unauthorized();
    error InvalidAddress();
    error InvalidToken();
    error InvalidFee();
    error InvalidMarket();
    error InvalidCurve();
    error InvalidTime();
    error MarketClosed();
    error MarketNotReady();
    error AlreadyResolved();
    error NotResolved();
    error InvalidAmount();
    error NothingToClaim();
    error AlreadyClaimed();
    error TransferFailed();
    error ReentrantCall();
    error InvalidBatch();

    uint256 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant MAX_BATCH_SIZE = 25;

    struct Market {
        address curve;
        uint64 resolveAfter;
        uint128 yesPool;
        uint128 noPool;
        bool outcomeYes;
        bool resolved;
    }

    address public owner;
    IERC20Launchcast public immutable stakeToken;
    address public feeRecipient;
    uint16 public feeBps;
    uint256 public marketCount;
    uint256 public accruedFees;

    mapping(uint256 marketId => Market market) private markets;
    mapping(uint256 marketId => mapping(address user => uint256 amount)) public yesStake;
    mapping(uint256 marketId => mapping(address user => uint256 amount)) public noStake;
    mapping(uint256 marketId => mapping(address user => bool claimed)) public hasClaimed;
    mapping(uint256 marketId => uint256 feeAmount) public marketFee;
    mapping(uint256 marketId => address recipient) public marketFeeRecipient;
    mapping(address recipient => uint256 amount) public accruedFeesByRecipient;

    uint256 private lockState = 1;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeConfigUpdated(uint16 feeBps, address indexed feeRecipient);
    event MarketCreated(uint256 indexed marketId, address indexed curve, uint64 resolveAfter);
    event BetPlaced(uint256 indexed marketId, address indexed user, bool indexed side, uint256 amount);
    event MarketResolved(uint256 indexed marketId, bool outcomeYes, uint256 yesPool, uint256 noPool, uint256 fee);
    event WinningsClaimed(uint256 indexed marketId, address indexed user, uint256 payout);
    event FeesWithdrawn(address indexed recipient, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (lockState != 1) revert ReentrantCall();
        lockState = 2;
        _;
        lockState = 1;
    }

    constructor(address stakeToken_, address feeRecipient_, uint16 feeBps_) {
        if (stakeToken_ == address(0) || feeRecipient_ == address(0) || feeRecipient_ == address(this)) revert InvalidAddress();
        if (stakeToken_.code.length == 0) revert InvalidToken();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();

        owner = msg.sender;
        stakeToken = IERC20Launchcast(stakeToken_);
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;

        emit OwnershipTransferred(address(0), msg.sender);
        emit FeeConfigUpdated(feeBps_, feeRecipient_);
    }

    /// @notice Create a market whose proposition is the curve's graduated() state at settlement.
    /// @dev The frontend must display this exact settlement meaning to users.
    function createMarket(address curve, uint64 resolveAfter) external onlyOwner returns (uint256 marketId) {
        if (curve == address(0) || curve.code.length == 0) revert InvalidCurve();
        if (resolveAfter <= block.timestamp) revert InvalidTime();
        if (_readGraduated(curve)) revert InvalidCurve(); // Markets start from a live, ungraduated curve.
        _validateVibeVibePair(curve);

        marketId = ++marketCount;
        markets[marketId] = Market({
            curve: curve,
            resolveAfter: resolveAfter,
            yesPool: 0,
            noPool: 0,
            outcomeYes: false,
            resolved: false
        });

        emit MarketCreated(marketId, curve, resolveAfter);
    }

    /// @notice Place or add to a YES or NO position before the market's settlement time.
    function placeBet(uint256 marketId, bool sideYes, uint256 amount) external nonReentrant {
        Market storage market = _getMarket(marketId);
        if (market.resolved) revert AlreadyResolved();
        if (block.timestamp >= market.resolveAfter) revert MarketClosed();
        if (amount == 0 || amount > type(uint128).max) revert InvalidAmount();

        if (sideYes) {
            uint256 nextPool = uint256(market.yesPool) + amount;
            if (nextPool > type(uint128).max) revert InvalidAmount();
            market.yesPool = uint128(nextPool);
            yesStake[marketId][msg.sender] += amount;
        } else {
            uint256 nextPool = uint256(market.noPool) + amount;
            if (nextPool > type(uint128).max) revert InvalidAmount();
            market.noPool = uint128(nextPool);
            noStake[marketId][msg.sender] += amount;
        }

        _safeTransferFrom(address(stakeToken), msg.sender, address(this), amount);
        emit BetPlaced(marketId, msg.sender, sideYes, amount);
    }

    /// @notice Anyone can settle an eligible market. Settlement is a user-submitted transaction.
    function settleMarket(uint256 marketId) external nonReentrant {
        _settle(marketId);
    }

    /// @notice Admin-dashboard convenience: settle up to 25 eligible markets in one transaction.
    /// @dev If any market in the batch is invalid or not ready, the whole transaction reverts.
    function settleMarkets(uint256[] calldata marketIds) external nonReentrant {
        uint256 length = marketIds.length;
        if (length == 0 || length > MAX_BATCH_SIZE) revert InvalidBatch();
        for (uint256 i; i < length; ++i) {
            _settle(marketIds[i]);
        }
    }

    /// @notice Claim a user's resolved position. A user with positions on both sides is netted
    ///         through the winning-side stake; the losing-side stake remains in the losing pool.
    function claim(uint256 marketId) external nonReentrant returns (uint256 payout) {
        Market storage market = _getMarket(marketId);
        if (!market.resolved) revert NotResolved();
        if (hasClaimed[marketId][msg.sender]) revert AlreadyClaimed();

        uint256 yesAmount = yesStake[marketId][msg.sender];
        uint256 noAmount = noStake[marketId][msg.sender];
        if (yesAmount == 0 && noAmount == 0) revert NothingToClaim();

        hasClaimed[marketId][msg.sender] = true;

        uint256 winningPool = market.outcomeYes ? market.yesPool : market.noPool;
        uint256 losingPool = market.outcomeYes ? market.noPool : market.yesPool;
        uint256 winningStake = market.outcomeYes ? yesAmount : noAmount;

        // If nobody backed the winning outcome, every participant gets their own stake back.
        if (winningPool == 0) {
            payout = yesAmount + noAmount;
        } else if (winningStake != 0) {
            uint256 distributableLosingPool = losingPool - _feeFor(marketId);
            payout = winningStake + (distributableLosingPool * winningStake) / winningPool;
        }

        if (payout != 0) _safeTransfer(address(stakeToken), msg.sender, payout);
        emit WinningsClaimed(marketId, msg.sender, payout);
    }

    /// @notice Each fee recipient can withdraw only fees allocated to their address at settlement.
    function withdrawFees() external nonReentrant {
        uint256 amount = accruedFeesByRecipient[msg.sender];
        if (amount == 0) revert NothingToClaim();
        accruedFeesByRecipient[msg.sender] = 0;
        accruedFees -= amount;
        _safeTransfer(address(stakeToken), msg.sender, amount);
        emit FeesWithdrawn(msg.sender, amount);
    }

    function setFeeConfig(uint16 newFeeBps, address newFeeRecipient) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFee();
        if (newFeeRecipient == address(0) || newFeeRecipient == address(this)) revert InvalidAddress();
        feeBps = newFeeBps;
        feeRecipient = newFeeRecipient;
        emit FeeConfigUpdated(newFeeBps, newFeeRecipient);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return _getMarket(marketId);
    }

    function getPosition(uint256 marketId, address user)
        external
        view
        returns (uint256 yesAmount, uint256 noAmount, bool claimed)
    {
        _getMarket(marketId);
        return (yesStake[marketId][user], noStake[marketId][user], hasClaimed[marketId][user]);
    }

    function _settle(uint256 marketId) internal {
        Market storage market = _getMarket(marketId);
        if (market.resolved) revert AlreadyResolved();
        if (block.timestamp < market.resolveAfter) revert MarketNotReady();

        bool outcomeYes = _readGraduated(market.curve);
        market.outcomeYes = outcomeYes;
        market.resolved = true;

        uint256 winningPool = outcomeYes ? market.yesPool : market.noPool;
        uint256 losingPool = outcomeYes ? market.noPool : market.yesPool;
        uint256 fee = 0;
        if (winningPool != 0 && losingPool != 0) {
            fee = (losingPool * feeBps) / 10_000;
            marketFee[marketId] = fee;
            address recipient = feeRecipient;
            marketFeeRecipient[marketId] = recipient;
            accruedFeesByRecipient[recipient] += fee;
            accruedFees += fee;
        }

        emit MarketResolved(marketId, outcomeYes, market.yesPool, market.noPool, fee);
    }

    function _feeFor(uint256 marketId) internal view returns (uint256) {
        return marketFee[marketId];
    }

    function _validateVibeVibePair(address curve) internal view {
        (bool curveOk, bytes memory curveData) = curve.staticcall(
            abi.encodeWithSelector(IVibeVibeCurveIdentity.token.selector)
        );
        if (!curveOk || curveData.length < 32) revert InvalidCurve();
        address tokenAddress = abi.decode(curveData, (address));
        if (tokenAddress == address(0) || tokenAddress.code.length == 0) revert InvalidCurve();

        (bool tokenOk, bytes memory tokenData) = tokenAddress.staticcall(
            abi.encodeWithSelector(IVibeVibeTokenIdentity.curve.selector)
        );
        if (!tokenOk || tokenData.length < 32) revert InvalidCurve();
        if (abi.decode(tokenData, (address)) != curve) revert InvalidCurve();
    }

    function _readGraduated(address curve) internal view returns (bool graduated_) {
        (bool success, bytes memory data) = curve.staticcall(abi.encodeWithSignature("graduated()"));
        if (!success || data.length < 32) revert InvalidCurve();
        graduated_ = abi.decode(data, (bool));
    }

    function _getMarket(uint256 marketId) internal view returns (Market storage market) {
        if (marketId == 0 || marketId > marketCount) revert InvalidMarket();
        market = markets[marketId];
    }

    /// @dev Launchcast supports exact-transfer, non-rebasing ERC-20 tokens only.
    function _safeTransfer(address token, address to, uint256 amount) internal {
        uint256 senderBefore = _balanceOf(token, address(this));
        uint256 recipientBefore = _balanceOf(token, to);
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Launchcast.transfer.selector, to, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        uint256 senderAfter = _balanceOf(token, address(this));
        uint256 recipientAfter = _balanceOf(token, to);
        if (
            senderAfter > senderBefore || senderBefore - senderAfter != amount ||
            recipientAfter < recipientBefore || recipientAfter - recipientBefore != amount
        ) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        uint256 senderBefore = _balanceOf(token, from);
        uint256 recipientBefore = _balanceOf(token, to);
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Launchcast.transferFrom.selector, from, to, amount)
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        uint256 senderAfter = _balanceOf(token, from);
        uint256 recipientAfter = _balanceOf(token, to);
        if (
            senderAfter > senderBefore || senderBefore - senderAfter != amount ||
            recipientAfter < recipientBefore || recipientAfter - recipientBefore != amount
        ) revert TransferFailed();
    }

    function _balanceOf(address token, address account) internal view returns (uint256 balance) {
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(IERC20Launchcast.balanceOf.selector, account)
        );
        if (!success || data.length < 32) revert InvalidToken();
        balance = abi.decode(data, (uint256));
    }
}
