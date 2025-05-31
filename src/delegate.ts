import 'dotenv/config'
import { 
  encodeRlp, 
  JsonRpcProvider, 
  Wallet, 
  toBigInt, 
  keccak256, 
  SigningKey, 
  concat, 
  AuthorizationLike,
  toBeHex
} from 'ethers'

async function main() {
  console.log('🚀 Starting EIP-7702 transaction process...')

  // ── 1. Provider & wallets setup ───────────────────────────────
  console.log('\n📡 Setting up provider and wallets...')
  const provider = new JsonRpcProvider(
    `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`
  )

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
  const messageHash = keccak256(
    concat([
      '0x05', // MAGIC_PREFIX: Domain separator for EIP-7702
      encodeRlp([
        chainId ? toBeHex(chainId) : '0x',
        delegatorAddr,
        authNonce ? toBeHex(authNonce) : '0x'
      ])
    ])
  )

  // Sign the authorization hash with the EOA key (Authority)
  const signature = await new SigningKey(authorizer.privateKey).sign(messageHash)
  
  const authorization: AuthorizationLike = {
    chainId,
    address: delegatorAddr!,
    nonce: authNonce,
    signature
  }

  console.log('Authorization object:', authorization)

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
    to: '0x0000000000000000000000000000000000000000',
    value: 0n,
    data: '0x',
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