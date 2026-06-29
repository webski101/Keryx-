/**
 * Verify USDC ERC-20 balance and Arc native gas balance for buyer wallet.
 * Requires BUYER_PRIVATE_KEY in .env.local and a funded wallet.
 */

import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createPublicClient, http, erc20Abi, formatUnits, formatEther } from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY;
if (!BUYER_KEY) {
  console.error("BUYER_PRIVATE_KEY not set. Run: npm run generate-wallets");
  process.exit(1);
}

const ARC_USDC = "0x3600000000000000000000000000000000000000";
const RPC = "https://rpc.testnet.arc.network";

const account = privateKeyToAccount(BUYER_KEY);
console.log(`Checking balances for: ${account.address}`);

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC) });

// ERC-20 USDC balance
const usdcRaw = await publicClient.readContract({
  address: ARC_USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [account.address],
});
console.log(`  USDC (ERC-20): ${formatUnits(usdcRaw, 6)} USDC`);

// Native gas balance (Arc gas token = USDC with 18 decimals)
const nativeRaw = await publicClient.getBalance({ address: account.address });
console.log(`  Native gas:    ${formatEther(nativeRaw)} (Arc native)`);

// Gateway balance via GatewayClient
const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: BUYER_KEY });
const balances = await gateway.getBalances();
console.log(`  Gateway available: ${balances.gateway.formattedAvailable}`);
console.log(`  Gateway pending:   ${balances.gateway.formattedPending ?? "0"}`);

if (usdcRaw === 0n) {
  console.log("\n⚠  No USDC found. Fund this wallet at: https://faucet.circle.com/");
} else {
  console.log("\n✓ Wallet funded. Run: npm start   (then npm run exercise)");
}
