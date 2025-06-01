# EIP-7702 Proof of Concept

This repository contains a proof of concept implementation for [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702), which enables EOAs (Externally Owned Accounts) to temporarily adopt smart contract code.

## Overview

EIP-7702 allows EOAs to set contract code for a single transaction, enabling smart contract functionality without permanent deployment. This repo demonstrates practical use cases through batch transaction execution and access control patterns.

## Smart Contracts

### 1. BatchDelegator (`src/contracts/batchDelegator.sol`)
A simple batch transaction executor that allows EOAs to:
- Execute multiple calls in a single transaction
- Forward ETH along with calls
- Emit events for batch execution tracking

### 2. BatchDelegatorWithCallers (`src/contracts/batchDelegatorWithCallers.sol`)
An advanced version with signature-based access control:
- **Admin Management**: Admin role can be transferred via signed messages
- **Caller Authorization**: Only authorized addresses can sign transaction batches
- **Signature Verification**: All operations require cryptographic signatures
- **Replay Protection**: Nonce-based system prevents replay attacks

## Scripts

### Delegation Operations
- `delegate.ts` - Set contract code on an EOA using EIP-7702
- `undelegate.ts` - Remove contract code from an EOA
- `delegate_and_execute.ts` - Set code and execute a batch in one transaction

### Example Usage
- `register_name.ts` - Demonstrates batch execution by registering a name on-chain

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables in `.env` (use the .env.example):

3. Run scripts:
   ```bash
   npm run delegate
   npm run delegate_and_execute
   npm run register_name
   npm run undelegate
   ```

## How It Works

1. **Authorization**: EOA signs an EIP-7702 authorization to adopt contract code
2. **Code Setting**: The authorization is included in a transaction to temporarily set the code
3. **Execution**: While the code is active, the EOA can execute smart contract functions
4. **Reversion**: The code can be removed, returning the EOA to its normal state

## Use Cases

- **Batch Transactions**: Execute multiple DeFi operations in a single transaction
- **Gasless Transactions**: Enable meta-transactions with signature-based execution
- **Temporary Smart Wallets**: Add smart contract features to EOAs without permanent migration
- **Access Control**: Implement sophisticated permission systems for EOA operations

## Security Features

- Signature verification for all privileged operations
- Nonce-based replay protection
- Time-bound execution with deadlines
- Admin-controlled caller management

## Dependencies

- `ethers.js` v6 - Ethereum interaction library
- `@openzeppelin/contracts` v5 - Cryptographic utilities
- `typescript` - Type-safe development
- `dotenv` - Environment configuration

_Please, do not use it in production_
