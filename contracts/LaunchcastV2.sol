// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVibeV6CurveStatus { function complete() external view returns (bool); }

interface IERC20LaunchcastV2 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title LaunchcastV2
/// @notice Pooled YES/NO markets with explicit resolver attestations and refundable void states.
/// @dev Resolver attestations are a disclosed trust assumption, not trustless on-chain price proofs.
contract LaunchcastV2 {
    error Unauthorized();
    error InvalidAddress();
    error InvalidFee();
    error InvalidMarket();
    error InvalidTime();
    error InvalidAmount();
    error MarketClosed();
    error MarketNotReady();
    error InvalidStatus();
    error InvalidEvidence();
    error InvalidSignatures();
    error InvalidResolverSet();
    error NothingToClaim();
    error AlreadyClaimed();
    error TransferFailed();
    error ReentrantCall();

    uint16 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant BPS = 10_000;
    uint64 public constant ATTESTATION_WINDOW = 24 hours;
    uint64 public constant CHALLENGE_WINDOW = 30 minutes;
    uint256 public constant MAX_STAKE = type(uint128).max;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("LaunchcastV2");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "MarketAttestation(uint256 chainId,address verifyingContract,uint256 marketId,bool outcome,uint64 observationBlock,uint64 observationTimestamp,bytes32 observationBlockHash,bytes32 evidenceHash,uint256 fdvValue,uint32 resolverVersion)"
    );
    uint256 private constant SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    enum MarketType {
        Graduation,
        Fdv12Hour,
        Fdv24Hour
    }
    enum MarketStatus {
        Open,
        Challenged,
        Disputed,
        Resolved,
        Voided
    }

    struct Market {
        MarketType marketType;
        MarketStatus status;
        address token;
        address curve;
        address pairCurrency;
        uint64 launchAt;
        uint64 observationAt;
        uint64 closeAt;
        uint64 maxObservationLag;
        uint64 observationBlock;
        uint64 observationTimestamp;
        uint64 challengeEndsAt;
        bytes32 observationBlockHash;
        bytes32 evidenceHash;
        bytes32 challengeEvidenceHash;
        uint256 targetFdv;
        uint256 attestedFdv;
        uint128 yesPool;
        uint128 noPool;
        bool outcomeYes;
        uint16 feeBps;
        address feeRecipient;
        uint32 resolverVersion;
        address[3] resolvers;
    }

    address public owner;
    IERC20LaunchcastV2 public immutable stakeToken;
    address public feeRecipient;
    uint16 public feeBps;
    uint32 public resolverVersion;
    uint256 public marketCount;
    uint256 public accruedFees;
    uint256 private lockState = 1;

    address[3] private activeResolvers;
    mapping(uint256 => Market) private markets;
    mapping(uint256 => mapping(address => uint256)) public yesStake;
    mapping(uint256 => mapping(address => uint256)) public noStake;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;
    mapping(address => uint256) public accruedFeesByRecipient;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeConfigUpdated(uint16 feeBps, address indexed feeRecipient);
    event ResolverSetUpdated(uint32 indexed version, address resolver0, address resolver1, address resolver2);
    event MarketCreated(
        uint256 indexed marketId,
        MarketType indexed marketType,
        address indexed token,
        address curve,
        address pairCurrency,
        uint64 launchAt,
        uint64 observationAt,
        uint64 closeAt,
        uint256 targetFdv
    );
    event BetPlaced(uint256 indexed marketId, address indexed user, bool indexed sideYes, uint256 amount);
    event AttestationSubmitted(
        uint256 indexed marketId,
        bool outcomeYes,
        uint64 observationBlock,
        bytes32 observationBlockHash,
        bytes32 evidenceHash,
        uint256 fdvValue,
        uint64 challengeEndsAt
    );
    event MarketDisputed(uint256 indexed marketId, bytes32 firstEvidenceHash, bytes32 challengeEvidenceHash);
    event MarketFinalized(uint256 indexed marketId, bool outcomeYes, uint256 yesPool, uint256 noPool, uint256 fee);
    event MarketVoided(uint256 indexed marketId, bytes32 reason);
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

    constructor(address stakeToken_, address feeRecipient_, uint16 feeBps_, address[3] memory resolvers_) {
        if (stakeToken_ == address(0) || stakeToken_.code.length == 0) revert InvalidAddress();
        if (
            feeRecipient_ == address(0) || feeRecipient_ == address(this) || feeRecipient_ == msg.sender
                || feeRecipient_ == stakeToken_
        ) revert InvalidAddress();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();
        _validateResolverSet(resolvers_, msg.sender, feeRecipient_, stakeToken_);
        owner = msg.sender;
        stakeToken = IERC20LaunchcastV2(stakeToken_);
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        activeResolvers = resolvers_;
        resolverVersion = 1;
        emit OwnershipTransferred(address(0), msg.sender);
        emit FeeConfigUpdated(feeBps_, feeRecipient_);
        emit ResolverSetUpdated(1, resolvers_[0], resolvers_[1], resolvers_[2]);
    }

    function createMarket(
        MarketType marketType,
        address token,
        address curve,
        address pairCurrency,
        uint64 launchAt,
        uint64 observationAt,
        uint64 closeAt,
        uint64 maxObservationLag,
        uint256 targetFdv
    ) external nonReentrant onlyOwner returns (uint256 marketId) {
        if (token == address(0) || token.code.length == 0 || curve == address(0) || curve.code.length == 0) {
            revert InvalidAddress();
        }
        if (
            launchAt == 0 || launchAt > block.timestamp || observationAt <= block.timestamp
                || closeAt <= block.timestamp || closeAt >= observationAt
        ) {
            revert InvalidTime();
        }
        if (marketType == MarketType.Fdv12Hour && observationAt != uint256(launchAt) + 12 hours) revert InvalidTime();
        if (marketType == MarketType.Fdv24Hour && observationAt != uint256(launchAt) + 24 hours) revert InvalidTime();
        if (maxObservationLag == 0 || maxObservationLag > 10 minutes) revert InvalidTime();
        if (marketType == MarketType.Graduation) {
            if (pairCurrency != address(0) || targetFdv != 0 || _readCurveComplete(curve)) revert InvalidMarket();
        } else {
            if (pairCurrency == address(0) || pairCurrency.code.length == 0 || targetFdv == 0) {
                revert InvalidMarket();
            }
            if (!_readCurveComplete(curve)) revert InvalidMarket();
        }

        marketId = ++marketCount;
        Market storage market = markets[marketId];
        market.marketType = marketType;
        market.status = MarketStatus.Open;
        market.token = token;
        market.curve = curve;
        market.pairCurrency = pairCurrency;
        market.launchAt = launchAt;
        market.observationAt = observationAt;
        market.closeAt = closeAt;
        market.maxObservationLag = maxObservationLag;
        market.targetFdv = targetFdv;
        market.feeBps = feeBps;
        market.feeRecipient = feeRecipient;
        market.resolverVersion = resolverVersion;
        market.resolvers = activeResolvers;

        emit MarketCreated(
            marketId, marketType, token, curve, pairCurrency, launchAt, observationAt, closeAt, targetFdv
        );
    }

    function placeBet(uint256 marketId, bool sideYes, uint256 amount) external nonReentrant {
        Market storage market = _getMarket(marketId);
        if (market.status != MarketStatus.Open) revert InvalidStatus();
        if (block.timestamp >= market.closeAt) revert MarketClosed();
        // A graduation market must stop accepting bets as soon as the V6 curve completes,
        // even when its scheduled closeAt is later. This is a conservative early-close guard;
        // the resolver still determines final graduation from canonical V4 pool evidence.
        if (market.marketType == MarketType.Graduation && _readCurveComplete(market.curve)) revert MarketClosed();
        if (amount == 0 || amount > MAX_STAKE) revert InvalidAmount();

        if (sideYes) {
            uint256 nextPool = uint256(market.yesPool) + amount;
            if (nextPool > MAX_STAKE) revert InvalidAmount();
            market.yesPool = uint128(nextPool);
            yesStake[marketId][msg.sender] += amount;
        } else {
            uint256 nextPool = uint256(market.noPool) + amount;
            if (nextPool > MAX_STAKE) revert InvalidAmount();
            market.noPool = uint128(nextPool);
            noStake[marketId][msg.sender] += amount;
        }
        _safeTransferFrom(msg.sender, address(this), amount);
        emit BetPlaced(marketId, msg.sender, sideYes, amount);
    }

    function submitAttestation(
        uint256 marketId,
        bool outcomeYes,
        uint64 observationBlock,
        uint64 observationTimestamp,
        bytes32 observationBlockHash,
        bytes32 evidenceHash,
        uint256 fdvValue,
        bytes[] calldata signatures
    ) external nonReentrant {
        Market storage market = _getMarket(marketId);
        if (market.status != MarketStatus.Open) revert InvalidStatus();
        if (block.timestamp < market.observationAt) revert MarketNotReady();
        if (block.timestamp > uint256(market.observationAt) + ATTESTATION_WINDOW) revert InvalidTime();
        _validateEvidence(
            market,
            marketId,
            outcomeYes,
            observationBlock,
            observationTimestamp,
            observationBlockHash,
            evidenceHash,
            fdvValue,
            signatures
        );

        market.status = MarketStatus.Challenged;
        market.outcomeYes = outcomeYes;
        market.observationBlock = observationBlock;
        market.observationTimestamp = observationTimestamp;
        market.observationBlockHash = observationBlockHash;
        market.evidenceHash = evidenceHash;
        market.attestedFdv = fdvValue;
        market.challengeEndsAt = uint64(block.timestamp + CHALLENGE_WINDOW);
        emit AttestationSubmitted(
            marketId, outcomeYes, observationBlock, observationBlockHash, evidenceHash, fdvValue, market.challengeEndsAt
        );
    }

    function challengeAttestation(
        uint256 marketId,
        bool outcomeYes,
        uint64 observationBlock,
        uint64 observationTimestamp,
        bytes32 observationBlockHash,
        bytes32 evidenceHash,
        uint256 fdvValue,
        bytes[] calldata signatures
    ) external nonReentrant {
        Market storage market = _getMarket(marketId);
        if (market.status != MarketStatus.Challenged || block.timestamp > market.challengeEndsAt) {
            revert InvalidStatus();
        }
        _validateEvidence(
            market,
            marketId,
            outcomeYes,
            observationBlock,
            observationTimestamp,
            observationBlockHash,
            evidenceHash,
            fdvValue,
            signatures
        );
        if (evidenceHash == market.evidenceHash && outcomeYes == market.outcomeYes) revert InvalidEvidence();
        market.status = MarketStatus.Disputed;
        market.challengeEvidenceHash = evidenceHash;
        emit MarketDisputed(marketId, market.evidenceHash, evidenceHash);
    }

    function finalizeMarket(uint256 marketId) external nonReentrant {
        Market storage market = _getMarket(marketId);
        if (market.status != MarketStatus.Challenged) revert InvalidStatus();
        if (block.timestamp <= market.challengeEndsAt) revert MarketNotReady();

        uint256 winningPool = market.outcomeYes ? market.yesPool : market.noPool;
        uint256 losingPool = market.outcomeYes ? market.noPool : market.yesPool;
        if (winningPool == 0) {
            market.status = MarketStatus.Voided;
            emit MarketVoided(marketId, keccak256("NO_WINNING_STAKES"));
            return;
        }

        uint256 fee = losingPool * market.feeBps / BPS;
        if (fee != 0) {
            accruedFees += fee;
            accruedFeesByRecipient[market.feeRecipient] += fee;
        }
        market.status = MarketStatus.Resolved;
        emit MarketFinalized(marketId, market.outcomeYes, market.yesPool, market.noPool, fee);
    }

    function voidDisputedMarket(uint256 marketId) external nonReentrant {
        Market storage market = _getMarket(marketId);
        if (market.status != MarketStatus.Disputed) revert InvalidStatus();
        market.status = MarketStatus.Voided;
        emit MarketVoided(marketId, keccak256("CONFLICTING_RESOLVER_QUORUMS"));
    }

    function voidUnattestedMarket(uint256 marketId) external nonReentrant {
        Market storage market = _getMarket(marketId);
        if (market.status != MarketStatus.Open) revert InvalidStatus();
        if (block.timestamp <= uint256(market.observationAt) + ATTESTATION_WINDOW) revert MarketNotReady();
        market.status = MarketStatus.Voided;
        emit MarketVoided(marketId, keccak256("ATTESTATION_TIMEOUT"));
    }

    function claim(uint256 marketId) external nonReentrant returns (uint256 payout) {
        Market storage market = _getMarket(marketId);
        if (market.status != MarketStatus.Resolved && market.status != MarketStatus.Voided) revert InvalidStatus();
        if (hasClaimed[marketId][msg.sender]) revert AlreadyClaimed();
        uint256 yesAmount = yesStake[marketId][msg.sender];
        uint256 noAmount = noStake[marketId][msg.sender];
        if (yesAmount == 0 && noAmount == 0) revert NothingToClaim();

        if (market.status == MarketStatus.Voided) {
            payout = yesAmount + noAmount;
        } else {
            uint256 winningPool = market.outcomeYes ? market.yesPool : market.noPool;
            uint256 winningStake = market.outcomeYes ? yesAmount : noAmount;
            // If nobody backed the winning outcome, there is no winner to receive the pool.
            // Refund every participant's own stake instead of locking all funds in the contract.
            if (winningPool == 0) {
                payout = yesAmount + noAmount;
            } else {
                // A losing position remains recorded as a loss; it cannot be claimed for zero payout.
                if (winningStake == 0) revert NothingToClaim();
                uint256 losingPool = market.outcomeYes ? market.noPool : market.yesPool;
                uint256 fee = losingPool * market.feeBps / BPS;
                payout = winningStake + (losingPool - fee) * winningStake / winningPool;
            }
        }
        hasClaimed[marketId][msg.sender] = true;
        if (payout != 0) _safeTransfer(msg.sender, payout);
        emit WinningsClaimed(marketId, msg.sender, payout);
    }

    function withdrawFees() external nonReentrant {
        uint256 amount = accruedFeesByRecipient[msg.sender];
        if (amount == 0) revert NothingToClaim();
        accruedFeesByRecipient[msg.sender] = 0;
        accruedFees -= amount;
        _safeTransfer(msg.sender, amount);
        emit FeesWithdrawn(msg.sender, amount);
    }

    function setFeeConfig(uint16 newFeeBps, address newFeeRecipient) external nonReentrant onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFee();
        if (
            newFeeRecipient == address(0) || newFeeRecipient == address(this) || newFeeRecipient == owner
                || newFeeRecipient == address(stakeToken) || _isActiveResolver(newFeeRecipient)
        ) revert InvalidAddress();
        feeBps = newFeeBps;
        feeRecipient = newFeeRecipient;
        emit FeeConfigUpdated(newFeeBps, newFeeRecipient);
    }

    function setResolvers(address[3] calldata newResolvers) external nonReentrant onlyOwner {
        _validateResolverSet(newResolvers, owner, feeRecipient, address(stakeToken));
        activeResolvers = newResolvers;
        unchecked {
            ++resolverVersion;
        }
        emit ResolverSetUpdated(resolverVersion, newResolvers[0], newResolvers[1], newResolvers[2]);
    }

    function transferOwnership(address newOwner) external nonReentrant onlyOwner {
        if (
            newOwner == address(0) || newOwner == address(this) || newOwner == feeRecipient
                || newOwner == address(stakeToken) || _isActiveResolver(newOwner)
        ) revert InvalidAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return _getMarket(marketId);
    }

    function getActiveResolvers() external view returns (address[3] memory) {
        return activeResolvers;
    }

    function attestationDigest(
        uint256 marketId,
        bool outcomeYes,
        uint64 observationBlock,
        uint64 observationTimestamp,
        bytes32 observationBlockHash,
        bytes32 evidenceHash,
        uint256 fdvValue
    ) external view returns (bytes32) {
        Market storage market = _getMarket(marketId);
        return _attestationDigest(
            marketId,
            outcomeYes,
            observationBlock,
            observationTimestamp,
            observationBlockHash,
            evidenceHash,
            fdvValue,
            market.resolverVersion
        );
    }

    function _validateEvidence(
        Market storage market,
        uint256 marketId,
        bool outcomeYes,
        uint64 observationBlock,
        uint64 observationTimestamp,
        bytes32 observationBlockHash,
        bytes32 evidenceHash,
        uint256 fdvValue,
        bytes[] calldata signatures
    ) internal view {
        if (
            observationBlock == 0 || observationBlockHash == bytes32(0) || evidenceHash == bytes32(0)
                || observationTimestamp > market.observationAt
                || uint256(market.observationAt) - observationTimestamp > market.maxObservationLag
        ) revert InvalidEvidence();
        if (market.marketType == MarketType.Graduation) {
            if (fdvValue != 0) revert InvalidEvidence();
        } else if (outcomeYes != (fdvValue >= market.targetFdv)) {
            revert InvalidEvidence();
        }
        if (signatures.length != 2) revert InvalidSignatures();
        bytes32 digest = _attestationDigest(
            marketId,
            outcomeYes,
            observationBlock,
            observationTimestamp,
            observationBlockHash,
            evidenceHash,
            fdvValue,
            market.resolverVersion
        );
        address signer0 = _recover(digest, signatures[0]);
        address signer1 = _recover(digest, signatures[1]);
        if (signer0 >= signer1 || !_isMarketResolver(market, signer0) || !_isMarketResolver(market, signer1)) {
            revert InvalidSignatures();
        }
    }

    function _attestationDigest(
        uint256 marketId,
        bool outcomeYes,
        uint64 observationBlock,
        uint64 observationTimestamp,
        bytes32 observationBlockHash,
        bytes32 evidenceHash,
        uint256 fdvValue,
        uint32 version
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                block.chainid,
                address(this),
                marketId,
                outcomeYes,
                observationBlock,
                observationTimestamp,
                observationBlockHash,
                evidenceHash,
                fdvValue,
                version
            )
        );
        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignatures();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1N_HALF || (v != 27 && v != 28)) revert InvalidSignatures();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignatures();
    }

    function _readCurveComplete(address curve) internal view returns (bool complete_) {
        (bool success, bytes memory data) = curve.staticcall(
            abi.encodeWithSelector(IVibeV6CurveStatus.complete.selector)
        );
        if (!success || data.length < 32) revert InvalidMarket();
        complete_ = abi.decode(data, (bool));
    }

    function _isMarketResolver(Market storage market, address signer) internal view returns (bool) {
        return signer == market.resolvers[0] || signer == market.resolvers[1] || signer == market.resolvers[2];
    }

    function _isActiveResolver(address candidate) internal view returns (bool) {
        return candidate == activeResolvers[0] || candidate == activeResolvers[1] || candidate == activeResolvers[2];
    }

    function _validateResolverSet(
        address[3] memory resolvers,
        address owner_,
        address feeRecipient_,
        address stakeToken_
    ) internal pure {
        if (
            resolvers[0] == address(0) || resolvers[1] == address(0) || resolvers[2] == address(0)
                || resolvers[0] == resolvers[1] || resolvers[0] == resolvers[2] || resolvers[1] == resolvers[2]
                || resolvers[0] == owner_ || resolvers[1] == owner_ || resolvers[2] == owner_
                || resolvers[0] == feeRecipient_ || resolvers[1] == feeRecipient_ || resolvers[2] == feeRecipient_
                || resolvers[0] == stakeToken_ || resolvers[1] == stakeToken_ || resolvers[2] == stakeToken_
        ) revert InvalidResolverSet();
    }

    function _getMarket(uint256 marketId) internal view returns (Market storage market) {
        if (marketId == 0 || marketId > marketCount) revert InvalidMarket();
        market = markets[marketId];
    }

    // Slither flags the before/after balance snapshots as reentrancy-balance
    // patterns. Every external path to this helper is protected by nonReentrant
    // (claim and withdrawFees); exact deltas intentionally reject taxed tokens.
    function _safeTransfer(address to, uint256 amount) internal {
        uint256 senderBefore = stakeToken.balanceOf(address(this));
        uint256 recipientBefore = stakeToken.balanceOf(to);
        (bool success, bytes memory data) =
            address(stakeToken).call(abi.encodeWithSelector(IERC20LaunchcastV2.transfer.selector, to, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        uint256 senderAfter = stakeToken.balanceOf(address(this));
        uint256 recipientAfter = stakeToken.balanceOf(to);
        if (
            senderAfter > senderBefore || senderBefore - senderAfter != amount || recipientAfter < recipientBefore
                || recipientAfter - recipientBefore != amount
        ) revert TransferFailed();
    }

    // placeBet is the only external path to this helper and is nonReentrant.
    // Keep exact sender/recipient deltas to reject fee-on-transfer stake assets.
    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        uint256 senderBefore = stakeToken.balanceOf(from);
        uint256 recipientBefore = stakeToken.balanceOf(to);
        (bool success, bytes memory data) =
            address(stakeToken).call(abi.encodeWithSelector(IERC20LaunchcastV2.transferFrom.selector, from, to, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        uint256 senderAfter = stakeToken.balanceOf(from);
        uint256 recipientAfter = stakeToken.balanceOf(to);
        if (
            senderAfter > senderBefore || senderBefore - senderAfter != amount || recipientAfter < recipientBefore
                || recipientAfter - recipientBefore != amount
        ) revert TransferFailed();
    }
}
