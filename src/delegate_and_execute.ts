// filename: sendSponsoredBatch.ts
import 'dotenv/config'

import { 
  encodeRlp, 
  JsonRpcProvider, 
  Wallet, 
  Interface, 
  toBigInt, 
  keccak256, 
  SigningKey, 
  concat, 
  recoverAddress, 
  Signature, 
  AuthorizationLike,
  toBeHex
} from 'ethers'

async function main() {
  console.log('🚀 Starting EIP-7702 transaction process...')
  console.log('Using Alchemy key:', process.env.ALCHEMY_KEY)

  // ── 1. Provider & wallets setup ───────────────────────────────
  console.log('\n📡 Setting up provider and wallets...')
  const provider = new JsonRpcProvider(`https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`)

  // Authorizer: signs the EIP-712 authorization (no ETH required)
  const authorizerKey = process.env.AUTHORIZER_PRIVATE_KEY!
  const authorizer = new Wallet(authorizerKey)

  // Relayer: pays for gas (must have Sepolia ETH)
  const relayerKey = process.env.RELAYER_PRIVATE_KEY!
  const relayer = new Wallet(relayerKey, provider)

  const chainId = (await provider.getNetwork()).chainId
  const authNonce = await provider.getTransactionCount(authorizer.address, 'pending')
  const relayerNonce = await provider.getTransactionCount(relayer.address, 'pending')

  console.log('Chain ID:', chainId)
  console.log('Authorizer address:', authorizer.address)
  console.log('Relayer address:', relayer.address)
  console.log('Authorizer nonce:', authNonce)
  console.log('Relayer nonce:', relayerNonce)

  // ── 2. EIP-7702 Authorization signature ───────────────────────
  console.log('\n✍️ Creating EIP-7702 authorization signature...')
  const delegatorAddr = process.env.DELEGATOR_ADDRESS!

  // Build authorization message hash: keccak256(0x05 || RLP([chainId, delegatedContract, authNonce]))
  const rlpEncoded = encodeRlp([
    toBeHex(chainId),
    delegatorAddr,
    authNonce ? toBeHex(authNonce) : '0x'
  ])

  const MAGIC_PREFIX = '0x05'  // Domain separator for EIP-7702
  const messageHash = keccak256(concat([MAGIC_PREFIX, rlpEncoded]))
  console.log('Old hash:', messageHash)

  const hash = keccak256(concat([
    '0x05',
    encodeRlp([
      chainId ? toBeHex(chainId) : '0x',
      delegatorAddr,
      authNonce ? toBeHex(authNonce) : '0x'
    ])
  ]))
  console.log('New hash:', hash)

  // Sign the authorization hash with the EOA key (Authority)
  // We use signTypedData or signMessage to avoid prefixes (signing the hash directly)
  const signature2 = await new SigningKey(authorizer.privateKey).sign(messageHash)
  const sigObj = Signature.from({ r: signature2.r, s: signature2.s, v: signature2.v })
  const signature = sigObj.serialized
  const recoveredAddress2 = recoverAddress(messageHash, sigObj.serialized)

  console.log('Recovered Authority:', recoveredAddress2, authorizer.address)
  console.log('Matches EOA:', recoveredAddress2 === authorizer.address)

  const authorization: AuthorizationLike = {
    chainId,
    address: delegatorAddr!,
    nonce: authNonce,
    signature
  }

  console.log('Authorization object:', authorization)

  // ── 3. Build the batch call (ERC-20 transfer) ─────────────────
  console.log('\n📦 Building batch call for ERC-20 transfer...')
  const tokenAddr = process.env.ERC20_ADDRESS
  const recipient = process.env.ERC20_RECIPIENT_ADDRESS
  const amount = toBigInt('1000000000000000000') // 1⋅10¹⁸

  console.log('Token address:', tokenAddr)
  console.log('Recipient:', recipient)
  console.log('Amount:', amount.toString())

  const erc20Iface = new Interface([
    'function transfer(address to, uint256 amount)'
  ])
  const transferData = erc20Iface.encodeFunctionData('transfer', [recipient, amount])
  console.log('Transfer data:', transferData)

  const transferData2 = erc20Iface.encodeFunctionData('transfer', [recipient, toBigInt('100000000000000000')])
  console.log('Transfer data:', transferData)

  const calls = [
    { target: tokenAddr, value: 0n, data: transferData },
    { target: tokenAddr, value: 0n, data: transferData2 }
  ]
  const batchIface = new Interface([
    'function executeBatch((address target,uint256 value,bytes data)[] calls)'
  ])
  const batchData = batchIface.encodeFunctionData('executeBatch', [calls])
  console.log('Batch data:', batchData)

  // ── 4. Build and send the transaction ────────────────────────
  console.log('\n🔨 Building and sending transaction...')
  
  // Create the transaction with EIP-7702 support
  const tx = {
    type: 4,
    chainId,
    nonce: relayerNonce,
    maxPriorityFeePerGas: toBigInt('1000000000'),
    maxFeePerGas: toBigInt('10000000000'),
    gasLimit: 2_000_000n,
    to: authorizer.address,
    value: 0n,
    data: batchData,
    accessList: [],
    authorizationList: [authorization]
  }

  console.log('Transaction object:', tx)

  // Sign and send the transaction
  console.log('\n📤 Sending transaction to network...')
  // Manually sign the transaction
  const raw = await relayer.signTransaction(tx)

  // Manually send it, bypassing ethers' hash check
  const txHash = await provider.send('eth_sendRawTransaction', [raw])
  console.log('↗️  Raw tx sent, hash =', txHash)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

/* 
dev
 {
  chainId: 11155111,
  address: '0x0eacc2307f0113f26840dd1dac8dc586259994dd',
  nonce: 0,
  signature: {
    r: '0xf938fe273b5b701c793262077dbfa89ddb2a1ad738bda71b56d4a80b9af2b1c3',
    s: '0x366f516541cedfc271517a97dce027fa3f9da17bfe4cf37b07a845e85f6d2b89',
    v: 28,
    yParity: 1
  }
}

    dev2

   {
  address: '0x0eacc2307f0113f26840dd1dac8dc586259994dd',
  chainId: 11155111,
  nonce: 0,
  r: '0x656f5bc834bca5954b6b2000b042c5a7d73e13d2af19fd63fe64b07f0240dba6',
  s: '0x7ed59420b7538f83ba1cc88a293ee3c39e7d8ed33c5dbc3aeb401193c53d71bd',
  v: 28n,
  yParity: 1
}



hash 0xfca05592428118347453f6e089fa9599642a77c5a479df9f93d1ae1cfe2e9914
authorization {
  address: '0x0eacc2307f0113f26840dd1dac8dc586259994dd',
  chainId: 11155111,
  nonce: 0,
  r: '0x1cd984c4655b08008d5ac04b56f73e4fac03ddd4fe00ad25d323fe02958bb257',
  s: '0x23695e97cdcffbc63bdc44cc029e75e37b0bdc4d8409d1e2522dde60638d11a6',
  v: 28n,
  yParity: 1
}


0xfca05592428118347453f6e089fa9599642a77c5a479df9f93d1ae1cfe2e9914
authorization object {
  chainId: 11155111,
  address: '0x0eacc2307f0113f26840dd1dac8dc586259994dd',
  nonce: 0,
  signature: {
    r: '0xf938fe273b5b701c793262077dbfa89ddb2a1ad738bda71b56d4a80b9af2b1c3',
    s: '0x366f516541cedfc271517a97dce027fa3f9da17bfe4cf37b07a845e85f6d2b89',
    v: 28,
    yParity: 1
  }
}
*/