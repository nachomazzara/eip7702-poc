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
      '0x05',  // MAGIC_PREFIX: Domain separator for EIP-7702
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

  // ── 3. Build the batch call (ERC-20 transfer) ─────────────────
  console.log('\n📦 Building batch call for ERC-20 transfer...')
  const tokenAddr = process.env.ERC20_ADDRESS
  const recipient = process.env.ERC20_RECIPIENT_1_ADDRESS
  const recipient2 = process.env.ERC20_RECIPIENT_2_ADDRESS

  const amount = toBigInt('1000000000000000000') // 1⋅10¹⁸

  console.log('Token address:', tokenAddr)
  console.log('Recipient:', recipient)
  console.log('Amount:', amount.toString())

  const erc20Iface = new Interface([
    'function transfer(address to, uint256 amount)'
  ])
  const transferData = erc20Iface.encodeFunctionData('transfer', [
    recipient,
    amount
  ])
  console.log('Transfer data:', transferData)

  const transferData2 = erc20Iface.encodeFunctionData('transfer', [
    recipient2,
    amount
  ])
  console.log('Transfer data:', transferData2)

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