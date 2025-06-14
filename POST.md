# Implementing EIP-7702: A (almost) Low-Level Guide

> This guide will walk you through implementing EIP-7702 (ERC-7702) at a low level, without using high-level functions from libraries or toolkits like ethers, viem, alchemy, etc. The goal is to understand the core concepts and mechanics of this EIP by implementing it from scratch. For high level understanding refer to [this (viem)](https://eip7702.io/examples#basic-authorization) and/or [this (ethers => wallet.authorize new method)](https://github.com/ethers-io/ethers.js/blob/main/src.ts/wallet/base-wallet.ts#L131)

## What is EIP-7702?

[EIP-7702](https://github.com/ethereum/EIPs/blob/master/EIPS/eip-7702.md), introduced in Ethereum's Pectra upgrade, enables traditional user wallets (EOAs) to temporarily leverage smart contract capabilities within individual transactions. This innovation allows users to batch transactions, benefit from sponsored (gasless) payments, integrate alternative authentication methods (social recovery), and set spending limits—all without permanently converting their accounts into smart contracts. The upgrade significantly simplifies user interactions and enhances Ethereum's usability, security, and flexibility.

## Introduction

This blog post walks you through implementing low-level [EIP-7702 transactions](https://eips.ethereum.org/EIPS/eip-7702), explicitly focusing on the authorization mechanism to clearly expose what happens behind the scenes, without relying on high-level abstractions from libraries like Ethers or Viem. Understanding the authorization process is crucial, as this is the key component that temporarily converts your Externally Owned Account (EOA) into a smart account capable of executing complex logic. Now, more than ever, it's essential to fully grasp what you're signing. A single careless signature could expose your EOA to unintended interactions and potential risks. Always double-check and fully understand each transaction you authorize. Stay safe!

💻 See [the repo](https://github.com/nachomazzara/eip7702-poc/blob/main/src) for full code examples.

In this guide, we'll walk through **three different scenarios** illustrating how EIP-7702 account delegation works in practice:

* [1️⃣ **Delegating to a Smart Contract**](#delegating-to-a-smart-contract)
* [2️⃣ **Delegate and Batch Execute (in a Single Transaction)**](#delegate-and-execute-in-a-single-transaction)
* [3️⃣ **Undelegating (Revoking Delegation)**](#undelegating-revoking-delegation)
* [🔢 **Bonus track: Advanced Use Cases and Considerations**](#bonus-track-advanced-use-cases-and-considerations) 

---

<a id="delegating-to-a-smart-contract"></a>
## 1️⃣ **Delegating to a Smart Contract**

First, we'll demonstrate how you can delegate your **Externally Owned Account (EOA)** to a previously deployed smart contract, temporarily (until you explicitly decide it) transforming your EOA into a smart account capable of executing advanced logic.

**Important:**
The initial smart contract used here is intentionally **unsafe** for demonstration purposes, as it does not restrict who can invoke its capabilities once delegated. In a real-world scenario, it's crucial to use an **audited and secure contract** that strictly validates signatures, ensuring that only transactions explicitly authorized by your EOA are executed.

These delegated interactions are referred to as **"User Operations."**

At the end of the blog post, we'll cover how you can enhance security to avoid risks.

### 🛠️ Step 1: Setting Up Provider and Wallets

* **Provider & Wallets Initialization**:
```typescript
  const provider = new JsonRpcProvider(
    `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`
  )

  // **Authorizer**: Signs off-chain authorization messages (does not require Ether). The EOA that will be converted to a smart account
  const authorizerKey = process.env.AUTHORIZER_PRIVATE_KEY!
  const authorizer = new Wallet(authorizerKey)

  // **Relayer**: Sends the transaction and covers gas costs (requires Ether). Used to simply simulate how a bundler or relayer will work
  const relayerKey = process.env.RELAYER_PRIVATE_KEY!
  const relayer = new Wallet(relayerKey, provider)

  const chainId = (await provider.getNetwork()).chainId
  const authNonce = await provider.getTransactionCount(
    authorizer.address, 
    'pending'
  )
  const relayerNonce = await provider.getTransactionCount(
    relayer.address, 
    'pending'
  )

  // **Delegator**: The EOA will delegate execution to this smart contract, running the contract's implementation and storage layout directly within the EOA's context, similar to how a delegatecall operates.
  const delegatorAddr = process.env.DELEGATOR_ADDRESS!
}
```

The Delegator contract used in this post has a single core method:
```typescript
function executeBatch(Call[] calldata calls)
```

This method allows you to execute multiple calls in one atomic transaction. Each Call includes a target address, a value in ETH (if any), and the data payload, typically the encoded function call.

When your EOA delegates to this contract (via EIP-7702), it adopts its logic temporarily, enabling batch execution as if it were a smart contract account.

You can view the full source code by expanding the section below

<details> <summary><strong>🔎 See Delegator Contract Code</strong></summary>

```typescript
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
```
See the code deployed on Sepolia: [0x0eacc2307f0113f26840dd1dac8dc586259994dd](https://sepolia.etherscan.io/address/0x0eacc2307f0113f26840dd1dac8dc586259994dd#code)
</details>

### 📝 Step 2: Creating EIP-7702 Authorization

According to EIP-7702, to delegate execution to a smart contract, an EOA must sign a message hash with the following structure and add a new object, the `authorizationList`, to the transaction payload :

```typescript
keccak256(0x05 || RLP([chainId, contract_address, nonce]))
```

- `0x05` is the MAGIC_PREFIX – a one-byte domain separator used to ensure the hash is unique to EIP-7702 and prevents cross-protocol replay attacks.

- `RLP([chainId, contract_address, nonce])` is a list of 3 values encoded using Ethereum's Recursive Length Prefix (RLP) encoding.

- The EOA must then sign this hash using its private key. This signature is what allows the EOA to delegate execution rights temporarily to the contract.


Now let's expand on how the `authorizationList` is used in EIP-7702 transactions and what parameters are required, following the spec and what the code is doing.

Each item in the list is an **authorization object**, and it must include three specific fields:

```typescript
const authorization: AuthorizationLike = {
  chainId,            // The chain where the delegation applies
  address: delegatorAddr, // The smart contract to which you are delegating execution
  nonce: authNonce,   // The current nonce of the EOA (prevents replay)
  signature           // The EOA-signed hash (see explanation above)
}
```

Here's what each parameter means:

---

#### 🔗 `chainId`

The `chainId` ensures the signature is valid only on a specific Ethereum chain (e.g., Sepolia, Mainnet). It prevents cross-chain replay attacks.

---

#### 🏛 `address`

This is the **delegator smart contract**—the contract the EOA wants to temporarily use as its execution logic. This address will receive and execute the calldata of the transaction as if it were the EOA.

---

#### 🔁 `nonce`

The `nonce` is taken from the EOA's current pending nonce (e.g., using `getTransactionCount(authorizer.address, 'pending')`). It ensures that the authorization is **used only once**. If you reuse the same authorization in another transaction, it will be invalid.

---

#### ✍️ `signature`

This is the EOA's **raw ECDSA signature** of the `messageHash` (see previous explanation). It proves that the EOA willingly authorized delegation to the contract at that nonce and on that chain.

It is signed using:

```typescript
const signature = await new SigningKey(authorizer.privateKey).sign(messageHash)
```

> Note: This is a low-level raw signature—not a typed signature like EIP-712. That simplicity makes it safer and less error-prone.

Once you have the full authorization object, you include it in the transaction like this:

```typescript
const tx = {
  type: 4,
  chainId,
  nonce: relayerNonce,
  ... // gas config, to, data, etc.
  authorizationList: [authorization]
}
```

This tells the Ethereum network:

> "I (EOA) authorize the smart contract at `address` to act on my behalf for this one transaction, validated by this signature and tied to my nonce."

This `authorizationList` is the **core mechanic** that temporarily turns your EOA into a smart account securely, safely, and without needing a permanent contract wallet.

---


Let's see the code:

```typescript
const messageHash = keccak256(concat([
    '0x05',  // MAGIC_PREFIX: Domain separator for EIP-7702
    encodeRlp([
      chainId ? toBeHex(chainId) : '0x',
      delegatorAddr,
      authNonce ? toBeHex(authNonce) : '0x'
    ])
  ]))

// Sign the authorization hash with the EOA key (Authority)
const signature = await new SigningKey(authorizer.privateKey).sign(messageHash)

const authorization: AuthorizationLike = {
    chainId,
    address: delegatorAddr!,
    nonce: authNonce,
    signature
}
```

### 🚀 Step 3: Sending the Transaction

We now have everything we need to send the transaction. Since we're only creating the delegation (and not executing anything yet), the transaction will have:

- Type: `0x04` (EIP-7702)

- Calldata: `0x` empty (0x)

- Authorization: the object we just created and signed

This transaction is sent by the relayer, not the EOA, so the user doesn't need to hold any ETH. The EOA only needs to sign the delegation message; the relayer pays for gas and submits the transaction on-chain. 

* Construct a type-4 transaction (EIP-7702 compatible):

```typescript
const tx = {
  type: 4,
  chainId,
  nonce: relayerNonce,
  maxPriorityFeePerGas: toBigInt('1000000000'),
  maxFeePerGas: toBigInt('10000000000'),
  gasLimit: 2_000_000n,
  to: '0x0000000000000000000000000000000000000000',
  value: 0n,
  data: '0x',
  accessList: [],
  authorizationList: [authorization]
}

const raw = await relayer.signTransaction(tx)
const txHash = await provider.send('eth_sendRawTransaction', [raw])
console.log('↗️  Raw tx sent, hash =', txHash)
```

Perfect! Now that the transaction is sent, you can head over to a block explorer (like [Etherscan for Sepolia](https://sepolia.etherscan.io/tx/0x3eed1e94f2c706ded9e6e995b8a6b2f9575903b1cf5b362ba7d3367782de9b47)) to verify everything. 

As mentioned above, we're **only creating the delegation**, not executing any logic within the delegated contract. To do that safely, we send the transaction to the **null address** `to: '0x0000000000000000000000000000000000000000'`

By setting `to` as `0x0` and leaving `data` empty (`0x`), we ensure:

* No function is called
* No ETH is transferred
* We're only registering the delegation through the `authorizationList`

This is a minimal, no-op transaction where the only effect is that the EOA **adopts the contract code temporarily**, enabling smart account behavior for future transactions.

✅ The EOA now has delegated code, but nothing was executed yet.

There, you'll see a new section under the transaction details labeled **Authorization List**. This is part of the new `0x04` transaction format introduced by EIP-7702.

If everything was successful, you should see:

* The **delegated smart contract address**
* The **EOA that authorized it**
* The **nonce** used
* The **signature** that validates the delegation

![Authority Match](https://hackmd.io/_uploads/Hk5---Yzgl.png)

You can see in Etherscan that the authority matches the authorizer address and the validity is `True`

![See new Transactions Type](https://hackmd.io/_uploads/ByqbW-Yzxg.png)

You can also see in the [address page](https://sepolia.etherscan.io/address/0xBA6E94cCd3EF39B5214dc945FB53ad4aadD0bcdb#authlist7702) the `Other Transactions` tab with the delegation created

This confirms that the delegation worked and your EOA is now temporarily behaving like a smart account linked to the delegator contract.

🧠 *Next Steps:* You can now send normal transactions to the EOA address and will use the delegator code. Check [this transaction](https://sepolia.etherscan.io/tx/0x651bacc2422f2d13d70a954c2d697194868a03998c79925510dd5c58f2ede7fc#eventlog) that performs an ERC-20 approval. It was sent to the EOA and the EOA is using the delegated contract implementation.

💻 See the full code [here.](https://github.com/nachomazzara/eip7702-poc/blob/main/src/delegate.ts)

---

<a id="delegate-and-execute-in-a-single-transaction"></a>
## 2️⃣ **Delegate and Execute (in a Single Transaction)**

Next, we'll explore how delegation and transaction execution can be performed atomically within the same operation. This method allows immediate execution without a separate delegation transaction, making the process efficient and user-friendly.

We'll provide clear, step-by-step code examples demonstrating this approach.

### 🔄 Use Case: Registering a Name via Smart Contract

Have you ever been frustrated by the clunky multi-transaction flows in Web3? 🤔

Imagine you're trying to register a unique name on a decentralized naming service. In the traditional approach, this simple action becomes a **UX nightmare**:

1. First, you need to **approve** the registry to spend your tokens (wait for confirmation... ⏳)
2. Then, you **call** the register function (wait again... ⏳)
3. Two transactions = double the gas fees 💸
4. Two signatures = double the friction 😫
5. If the first succeeds but the second fails? You're stuck with a dangling approval! 🚨

**But what if you could do it all in ONE atomic transaction?** 🎯

That's exactly what we're about to show you! With EIP-7702, we'll transform this painful two-step dance into a **single, elegant operation**. No more waiting between steps, no more double gas fees, and no more worrying about partial failures.

**Ready to see the magic?** In the following sections, we'll walk you through how to interact with a **Name Registry contract**, which allows users to register a name by minting an NFT in exchange for 100 tokens:

- How to build the batch calldata 🧱
- How to combine delegation with execution 🔗
- How to send it all in one beautiful transaction 🚀

Let's dive in and build something amazing! 👇

---

### 🧪 Smart Contract Overview: Name Registry

The contract we're using includes a `register` function:

```solidity
function register(string _name, address _beneficiary) external;
```

When called, it:

* Deducts **100 tokens** from the caller
* Mints a **Name NFT** with the provided `_name`
* Assigns it to the `_beneficiary`

But before doing this, the caller (your EOA) must approve the registry contract to spend tokens—normally a separate transaction.

---

### 🧰 EIP-7702 to the Rescue

We'll combine both actions into a single transaction:

1. `approve(tokenSpender, 100e18)` — ERC-20 approval
2. `register("myname", myEOA)` — call the registry

These two actions are wrapped into a batch and executed via the **delegated contract**.

---

### ⚙️ Prerequisite

Before doing this, you must ensure your EOA **has 100 tokens**. If not, mint or transfer tokens to the EOA first so the `register` call doesn't fail due to insufficient balance.

---

✅ With delegation + batching, this flow becomes smoother and more gas-efficient—while also enabling true **gasless UX** when combined with a relayer.

---

### 🧱 Building the `calldata` for Delegate + Execute

To execute multiple actions in a single transaction, we need to construct the `calldata` that our delegated smart contract will receive. This calldata encodes a **batch** of low-level calls that will be forwarded by the `executeBatch()` function in our delegator contract.

We follow the **same delegation flow as before**, but instead of leaving the calldata empty (`0x`), we now include our batch payload.

Let's focus on how we construct that calldata:

```typescript
// 1. Approve calldata
const erc20Interface = new Interface([
  'function approve(address spender, uint256 amount)'
]);

const approveCalldata = erc20Interface.encodeFunctionData(
  'approve',
  [dclController, amount]
);

// 2. Register calldata
const registerInterface = new Interface([
  'function register(string _name, address _beneficiary)'
]);

const name = '0xhackmd';
const registerCalldata = registerInterface.encodeFunctionData(
  'register',
  [name, authorizer.address]
);

// 3. Combine into batched calls
const calls = [
  { target: tokenAddr, value: 0n, data: approveCalldata },
  { target: dclController, value: 0n, data: registerCalldata }
];

// 4. Encode batch using delegator's interface
const batchIface = new Interface([
  'function executeBatch((address target,uint256 value,bytes data)[] calls)'
]);

const batchData = batchIface.encodeFunctionData('executeBatch', [calls]);
```

---

### 📦 What's Happening Here?

* We first **encode an ERC-20 approval**, allowing the controller contract to spend tokens on behalf of the EOA.
* Then we **encode a call to the Name Registry's `register()` method**, which performs the NFT minting.
* Both calls are wrapped in a single array and encoded via `executeBatch(...)` from the Delegator contract.

This `batchData` is what we set as the `data` field in the transaction. The `to` field should now be set to the **EOA address**, because it has already delegated its code via EIP-7702.

Together with the `authorizationList`, this creates a transaction that **delegates and executes atomically**.

---

### 🚀 Sending the Delegate + Execute Transaction

We now have everything we need to send the transaction.

Unlike the previous delegation-only step—where we sent the transaction to `0x0` with empty calldata—this time we are **executing logic**, so:

* The `to` field must be the **EOA address** (since it now temporarily runs the delegated contract logic)
* The `data` field must contain the **batch calldata** we just built (`batchData`)

Here's how the final transaction object looks:

```typescript
const tx = {
  type: 4,                            // EIP-7702 transaction type
  chainId,
  nonce: relayerNonce,
  maxPriorityFeePerGas: toBigInt('1000000000'),  // 1 Gwei
  maxFeePerGas: toBigInt('10000000000'),         // 10 Gwei
  gasLimit: 2_000_000n,
  to: authorizer.address,            // EOA address (not the delegator contract)
  value: 0n,
  data: batchData,                   // Encoded executeBatch with our two actions
  accessList: [],
  authorizationList: [authorization] // Same structure as before
};

const raw = await relayer.signTransaction(tx)
const txHash = await provider.send('eth_sendRawTransaction', [raw])
console.log('↗️  Raw tx sent, hash =', txHash)
```

This transaction is once again sent by the **relayer**, not the EOA. The EOA only signed the authorization message—allowing the relayer to pay gas and perform the full delegate+execute workflow on their behalf.

---

Once confirmed, you'll see on the [block explorer](https://sepolia.etherscan.io/tx/0x477f3fba2f50a0ff01fc55aa940a2f2eacdd8abcf1806a30fbba244d9e12d5f5) that:

* The transaction was sent **to the EOA**
* The **authorization** was used
* The **approve** and **register** calls were executed atomically in a single step and now the authorizer has [100 tokens less](https://sepolia.etherscan.io/address/0xba6e94ccd3ef39b5214dc945fb53ad4aadd0bcdb#tokentxns) and a [new NFT name](https://sepolia.etherscan.io/address/0xba6e94ccd3ef39b5214dc945fb53ad4aadd0bcdb#nfttransfers)

![Tokens Transferred](https://hackmd.io/_uploads/rkhmdbYGlg.png)
![NFT Minted](https://hackmd.io/_uploads/BJn7ObYMel.png)

✅ You've now successfully delegated and executed in a single transaction!

💻 See the full code [here.](https://github.com/nachomazzara/eip7702-poc/blob/main/src/register_name.ts)
    
---

<a id="undelegating-revoking-delegation"></a>
## 3️⃣ **Undelegating (Revoking Delegation)**

This section demonstrates how to **revoke a previously granted delegation**, effectively disabling the smart account behavior of the EOA.

Revoking delegation is essential for restoring full control to the EOA and ensuring that no further interactions can be executed through the delegated contract.

The process is nearly identical to the initial delegation transaction, with one key difference:

> The `authorization.address` (delegated address) must be set to the **zero address**:
> `0x0000000000000000000000000000000000000000`

This signals to the network that the EOA no longer wishes to execute any smart contract logic and is returning to standard behavior.

The rest of the transaction (type `0x04`, signed authorization, etc.) remains the same.

Code example and transaction structure for undelegation follow in the next section.

```typescript
// Set up accounts...

const delegatorAddr = '0x0000000000000000000000000000000000000000'

// Sign and build authorization payload...

const tx = {
    type: 4,
    chainId,
    nonce: relayerNonce,
    maxPriorityFeePerGas: toBigInt('1000000000'),
    maxFeePerGas: toBigInt('10000000000'),
    gasLimit: 2_000_000n,
    to: '0x0000000000000000000000000000000000000000',
    value: 0n,
    data: '0x',
    accessList: [],
    authorizationList: [authorization]
}

// Send transaction
```

Now, you can manually verify the undelegation by checking the **Authorization List** section in the transaction:

🔗 [View transaction on Sepolia Etherscan](https://sepolia.etherscan.io/tx/0x010d31cb5ce4435cd7c84938b59ac4db9e4d545985d159498d7e17c56fb51637#authorizationlist)

![Delegation to empty address](https://hackmd.io/_uploads/HkZqjZtMxl.png)

Once there, confirm the following:

* The **Delegated Address** is:
  `0x0000000000000000000000000000000000000000`

This means the EOA has revoked any previously assigned smart contract logic and is now back to regular EOA behavior—no contract execution will occur on its behalf going forward. Check [this transaction](https://sepolia.etherscan.io/tx/0xf6dd2dff39db1f6707a97de6bfb21ef5785e5683e418debe380948f24f3bf7a5) that calls the EOA but no code is executed.

✅ This completes the undelegation step.

💻 See the full code [here.](https://github.com/nachomazzara/eip7702-poc/blob/main/src/undelegate.ts)

---

<a id="bonus-track-advanced-use-cases-and-considerations"></a>
## 🔢 Bonus Track: Advanced Use Cases and Considerations

Below are some key patterns and ideas for extending delegation securely and flexibly.

### 🛡️ 1. Safe Delegator with Signature Verification

Instead of using a minimal delegator that blindly forwards calls, a safer approach is to use a delegator that **verifies the EOA's signature on each individual User Operation**.

> ⚠️ Once you sign an EIP-7702 authorization, you are effectively telling the network:
> “This contract can act on my behalf.”

That means **anyone** can send transactions to that delegated contract in your name, **as long as it's during the active delegation window**. If the contract doesn't have internal logic to verify who called it (like checking the sender or validating per-call signatures), then **anyone could potentially call sensitive functions**, drain your assets, or exploit approvals.

So please:
**Always check what you're signing**, and make sure any delegated contract includes strict verification mechanisms. With great power (temporary smart accounts) comes great responsibility (not getting rekt).


This typically includes:

* A `UserOperation` struct with fields like `nonce`, `target`, `data`, etc.
* ECDSA signature verification (`ecrecover`) inside the smart contract
* Replay protection using nonces

This ensures that even once delegation is active, only explicitly signed actions by the EOA are executed.

> ✅ Recommended for production use to prevent unauthorized access or abuse.

```typescript
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
        bytes32 messageHash = getBatchHash(
            signedBatch.calls, signedBatch.nonce, signedBatch.deadline
        );
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(
            messageHash
        );
        address signer = ECDSA.recover(
            ethSignedMessageHash,
            signedBatch.signature
        );
        
        // Check if signer is an allowed caller
        if (!allowedCallers[signer]) revert NotAllowedCaller();

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
```

#### 🔍 How Signature Verification Works

Here's what this contract does to ensure **only authorized operations are executed**:

* `deadline` and `nonce` provide replay protection and time-bound validity.
* The contract uses `getBatchHash(...)` to hash:

  * The list of calls
  * The nonce
  * The deadline
* It then wraps that hash using `toEthSignedMessageHash(...)`, mimicking `eth_sign` behavior.
* Finally, it uses `ECDSA.recover(...)` to extract the **signer** from the provided signature.

If the recovered `signer` **does not match any of the allowedCallers** (i.e., the current EOA being impersonated via EIP-7702), the transaction reverts with `InvalidSignature`.

> ✅ This guarantees that only the account that originally authorized the delegation can execute batches, adding an important layer of security.

This type of delegator transforms the EOA into a true **programmable smart account**, while still respecting the minimal and temporary nature of EIP-7702 delegation.

You can check the full code [here](https://github.com/nachomazzara/eip7702-poc/blob/main/src/contracts/batchDelegatorWithCallers.sol)

---

### 🔐 2. Delegator with Social Recovery or Multi-Signer Logic

Another extension is to design the delegator with **social recovery mechanisms** or **multi-signer logic**, where:

* Additional addresses (guardians, recovery keys, etc.) can be added over time
* The EOA can delegate permission to more than one signer
* Recovery or revocation can be triggered if the primary key is lost

This turns the delegator into a more complete **smart account** or **wallet contract**, bringing flexibility and resilience while maintaining EIP-7702's temporary delegation model.

Below is an example of a function that updates the list of allowed callers, but only after verifying a signature from the designated admin. Remember that you can enhance social recovery by using the same approach for having multiple admins:

```typescript
/// @notice Update callers (add or remove) with signature verification
/// @param signedUpdate The signed update containing callers, add/remove flags, nonce, deadline and signature
function updateCallers(SignedCallerUpdate calldata signedUpdate) external {
    // Check arrays length
    if (signedUpdate.callers.length != signedUpdate.isAdding.length) revert ArrayLengthMismatch();
    
    // Check deadline
    if (block.timestamp > signedUpdate.deadline) revert DeadlineExpired();
    
    // Check nonce
    if (usedNonces[signedUpdate.nonce]) revert NonceAlreadyUsed();
    usedNonces[signedUpdate.nonce] = true;

    // Verify signature from admin
    bytes32 messageHash = getCallerUpdateHash(
        signedUpdate.callers, 
        signedUpdate.isAdding, 
        signedUpdate.nonce, 
        signedUpdate.deadline
    );
    bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(messageHash);
    address signer = ECDSA.recover(ethSignedMessageHash, signedUpdate.signature);
    
    if (signer != admin) revert InvalidSignature();

    // Update callers
    for (uint256 i = 0; i < signedUpdate.callers.length; i++) {
        allowedCallers[signedUpdate.callers[i]] = signedUpdate.isAdding[i];
        emit CallerUpdated(signedUpdate.callers[i], signedUpdate.isAdding[i]);
    }
}
```

You can check the full code [here](https://github.com/nachomazzara/eip7702-poc/blob/main/src/contracts/batchDelegatorWithCallers.sol)

---

### 🔁 3. Multiple Delegations: Last One Wins

If multiple `authorizationList` entries are submitted for the same EOA in the same transaction, the **last one included in the transaction takes effect**. This is why it is not possible to delegate and undelegate within the same transaction.

--- 

Thanks all. Thanks for reading!

Hope this post helped you understand the mechanics of EIP-7702 a little better—or at least sparked some curiosity. [Here](https://github.com/nachomazzara/eip7702-poc) you can find the repo for full code examples.

Feel free to reach out on [Twitter](https://x.com/nachomazzara) if you have questions, ideas, or just want to nerd out.

See you on-chain!