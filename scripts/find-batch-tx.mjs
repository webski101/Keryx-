/**
 * Finds the on-chain batch settlement transaction for a Gateway transfer.
 *
 * Circle batches payments into periodic on-chain txs against the GatewayWallet
 * contract. getTransferById() returns status/accounting but not the batch txHash.
 * We scan blocks near the transfer's updatedAt timestamp for txs to GatewayWallet.
 */
import { createPublicClient, http } from "viem";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const GATEWAY_WALLET = "0x0077777d7eba4688bdef3e311b846f25870a19b9";
const RPC = "https://rpc.testnet.arc.network";

const publicClient = createPublicClient({
  transport: http(RPC),
});

const gateway = new GatewayClient({
  chain: "arcTestnet",
  privateKey: process.env.BUYER_PRIVATE_KEY,
});

const transferId = process.argv[2] ?? "e9ccf6cb-e30c-4f63-ae0d-1060e9135896";
const transfer = await gateway.getTransferById(transferId);
console.log("Transfer:", JSON.stringify(transfer, null, 2));

const settledAt = new Date(transfer.updatedAt).getTime() / 1000; // unix seconds

// Binary-search for the block near settledAt
async function findBlockNear(targetTs) {
  let lo = 1n;
  let hi = await publicClient.getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await publicClient.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) < targetTs) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

console.log(`\nLocating block near ${transfer.updatedAt}...`);
const nearBlock = await findBlockNear(settledAt);
console.log(`Block ~${nearBlock}`);

// Scan ±50 blocks for txs TO the GatewayWallet contract
const from = nearBlock > 50n ? nearBlock - 50n : 1n;
const to = nearBlock + 50n;
console.log(`\nScanning blocks ${from}–${to} for txs to GatewayWallet...`);

const matches = [];
for (let bn = from; bn <= to; bn++) {
  const block = await publicClient.getBlock({ blockNumber: bn, includeTransactions: true });
  for (const tx of block.transactions) {
    if (tx.to?.toLowerCase() === GATEWAY_WALLET) {
      matches.push({ blockNumber: bn, hash: tx.hash, from: tx.from, timestamp: new Date(Number(block.timestamp) * 1000).toISOString() });
    }
  }
}

if (matches.length === 0) {
  console.log("No txs to GatewayWallet in this range. Try expanding the window.");
} else {
  console.log(`\nFound ${matches.length} GatewayWallet tx(s):`);
  for (const m of matches) {
    console.log(`  ${m.timestamp}  block=${m.blockNumber}  from=${m.from}`);
    console.log(`  hash: ${m.hash}`);
    console.log(`  arcscan: https://testnet.arcscan.app/tx/${m.hash}`);
  }
}
