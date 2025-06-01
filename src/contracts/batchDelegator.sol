// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title 7702 Batch Delegator
/// @notice Under an EIP-7702 set-code tx, your EOA can adopt this code and forward **batches** of calls.
///         Sign an authorization for this contract's address, then send a type-0x04 tx
///         to your EOA with data = abi.encodeWithSelector(BatchDelegator.executeBatch.selector, calls).
contract BatchDelegator {
    struct Call {
        address target;
        uint256 value;
        bytes   data;
    }

    /// @param signer   The EOA that drove this execution (msg.sender once code is injected).
    /// @param calls    The batch of calls made.
    /// @param results  The returned data from each call.
    event BatchExecuted(
        address indexed signer,
        Call[]   calls,
        bytes[]  results
    );

    /// @notice Forwards a batch of calls (and any ETH) atomically.
    /// @param calls  An array of { target, value, data } structs.
    ///                The sum of all `value` fields must be ≤ msg.value.
    /// @return results  An array of return data, one per call.
    function executeBatch(Call[] calldata calls)
        external
        payable
        returns (bytes[] memory results)
    {
        uint256 n = calls.length;
        results = new bytes[](n);

        // Forward each call
        for (uint256 i = 0; i < n; i++) {
            Call calldata c = calls[i];
            (bool ok, bytes memory ret) = c.target.call{ value: c.value }(c.data);
            require(ok, "BatchDelegator: call failed");

            if (ret.length > 0) {
                bool success = abi.decode(ret, (bool));
                require(success, "BatchDelegator: call returned false");
            }
            results[i] = ret;
        }

        emit BatchExecuted(msg.sender, calls, results);
        return results;
    }
}