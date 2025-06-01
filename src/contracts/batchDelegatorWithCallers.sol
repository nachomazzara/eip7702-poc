// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title 7702 Batch Delegator with Signature Verification
/// @notice Under an EIP-7702 set-code tx, your EOA can adopt this code and forward **batches** of calls.
///         All operations require signatures from the authorized party.
contract BatchDelegator {
    struct Call {
        address target;
        uint256 value;
        bytes   data;
    }

    struct SignedBatch {
        Call[] calls;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    struct SignedAdminChange {
        address newAdmin;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    // State variables
    address public admin;
    mapping(uint256 => bool) public usedNonces;
    bool private initialized;

    // Events
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);
    event BatchExecuted(
        address indexed signer,
        address indexed executor,
        Call[]   calls,
        bytes[]  results
    );

    // Errors
    error InvalidSignature();
    error DeadlineExpired();
    error NonceAlreadyUsed();
    error AlreadyInitialized();

    /// @notice Initialize the contract with an admin
    /// @param _admin The address of the initial admin
    function initialize(address _admin) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        admin = _admin;
        emit AdminChanged(address(0), _admin);
    }

    /// @notice Set a new admin with signature verification
    /// @param signedChange The signed admin change containing new admin, nonce, deadline and signature
    function setAdmin(SignedAdminChange calldata signedChange) external {
        // Check deadline
        if (block.timestamp > signedChange.deadline) revert DeadlineExpired();
        
        // Check nonce
        if (usedNonces[signedChange.nonce]) revert NonceAlreadyUsed();
        usedNonces[signedChange.nonce] = true;

        // Verify signature from current admin
        bytes32 messageHash = getAdminChangeHash(signedChange.newAdmin, signedChange.nonce, signedChange.deadline);
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(messageHash);
        address signer = ECDSA.recover(ethSignedMessageHash, signedChange.signature);
        
        if (signer != admin) revert InvalidSignature();

        address previousAdmin = admin;
        admin = signedChange.newAdmin;
        emit AdminChanged(previousAdmin, signedChange.newAdmin);
    }

    /// @notice Forwards a batch of calls with signature verification
    /// @param signedBatch The signed batch containing calls, nonce, deadline and signature
    /// @return results An array of return data, one per call
    function executeBatch(SignedBatch calldata signedBatch)
        external
        payable
        returns (bytes[] memory results)
    {
        // Check deadline
        if (block.timestamp > signedBatch.deadline) revert DeadlineExpired();
        
        // Check nonce
        if (usedNonces[signedBatch.nonce]) revert NonceAlreadyUsed();
        usedNonces[signedBatch.nonce] = true;

        // Verify signature
        bytes32 messageHash = getBatchHash(signedBatch.calls, signedBatch.nonce, signedBatch.deadline);
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(messageHash);
        address signer = ECDSA.recover(ethSignedMessageHash, signedBatch.signature);
        
        if (signer != address(this)) revert InvalidSignature();

        uint256 n = signedBatch.calls.length;
        results = new bytes[](n);

        // Forward each call
        for (uint256 i = 0; i < n; i++) {
            Call calldata c = signedBatch.calls[i];
            (bool ok, bytes memory ret) = c.target.call{ value: c.value }(c.data);
            require(ok, "BatchDelegator: call failed");

            if (ret.length > 0) {
                bool success = abi.decode(ret, (bool));
                require(success, "BatchDelegator: call returned false");
            }
            results[i] = ret;
        }

        emit BatchExecuted(address(this), msg.sender, signedBatch.calls, results);
        return results;
    }

    /// @notice Get the hash of a batch for signing
    /// @param calls The calls in the batch
    /// @param nonce The nonce for replay protection
    /// @param deadline The deadline for the batch execution
    /// @return The hash of the batch
    function getBatchHash(Call[] calldata calls, uint256 nonce, uint256 deadline) public pure returns (bytes32) {
        return keccak256(abi.encode(calls, nonce, deadline));
    }

    /// @notice Get the hash of an admin change for signing
    /// @param newAdmin The new admin address
    /// @param nonce The nonce for replay protection
    /// @param deadline The deadline for the admin change
    /// @return The hash of the admin change
    function getAdminChangeHash(address newAdmin, uint256 nonce, uint256 deadline) public pure returns (bytes32) {
        return keccak256(abi.encode(newAdmin, nonce, deadline));
    }
}