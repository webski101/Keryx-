import { createPublicClient, http, keccak256, toBytes } from "viem";

const RPC = "https://rpc.testnet.arc.network";
const publicClient = createPublicClient({ transport: http(RPC) });

const BUYER      = "0x98b4d5681c469dc1a197075c755d9021d2492ff2";
const SELLER     = "0xa69bdf6ca299d421318c05cd91efb35a29e56180";
const AMOUNT_HEX = "00000000000000000000000000000000000000000000000000000000000007d0"; // 2000
const CANDIDATES = [
  "0x60496e0a86ac3dc5e248bcd8c109dcccec989bd8815601d7fc4a841c7d891fac",
  "0x360dd89321d236cbcd2779801fb2d3ab41f2a6576f08b45cc01158f88e960a95",
];

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));

// ── 1. Show the custom event emitted by both candidate txs ───────────────────
console.log("=== Raw logs from candidate transactions ===");
for (const hash of CANDIDATES) {
  const receipt = await publicClient.getTransactionReceipt({ hash });
  console.log(`\nTx ${hash.slice(0, 18)}...  (${receipt.logs.length} log(s))`);
  for (const [i, log] of receipt.logs.entries()) {
    console.log(`  Log[${i}]:`);
    console.log(`    contract: ${log.address}`);
    console.log(`    topic0:   ${log.topics[0]}`);
    console.log(`    topic1:   ${log.topics[1]}`);
    console.log(`    topic2:   ${log.topics[2]}`);
    console.log(`    topic3:   ${log.topics[3]}`);
    console.log(`    data:     ${log.data || "(empty)"}`);
    const isTransfer = log.topics[0] === TRANSFER_TOPIC;
    console.log(`    is standard ERC-20 Transfer: ${isTransfer}`);
  }
}

// ── 2. Search for buyer address in calldata ──────────────────────────────────
console.log("\n=== Buyer address in calldata ===");
const buyerStripped = BUYER.slice(2).toLowerCase();
const sellerStripped = SELLER.slice(2).toLowerCase();

for (const hash of CANDIDATES) {
  const tx = await publicClient.getTransaction({ hash });
  const input = tx.input.toLowerCase();
  const hasBuyer  = input.includes(buyerStripped);
  const hasSeller = input.includes(sellerStripped);
  const hasAmount = input.includes(AMOUNT_HEX);
  console.log(`\nTx ${hash.slice(0, 18)}...`);
  console.log(`  calldata length: ${tx.input.length} bytes (hex chars)`);
  console.log(`  contains buyer  (${BUYER}): ${hasBuyer}`);
  console.log(`  contains seller (${SELLER}): ${hasSeller}`);
  console.log(`  contains amount 2000 (0x7d0 padded): ${hasAmount}`);
  if (hasBuyer) {
    // Find offset in calldata
    const offset = input.indexOf(buyerStripped);
    console.log(`  buyer first appears at input byte offset ~${offset / 2}`);
  }
}

// ── 3. Broad Transfer scan: any contract, ±5 blocks, filter non-empty data ───
console.log("\n=== Transfer events near block 49247070 with non-empty data ===");
const CENTER = 49247070n;
const logs = await publicClient.getLogs({
  fromBlock: CENTER - 5n,
  toBlock:   CENTER + 5n,
  topics: [[TRANSFER_TOPIC]],
});
console.log(`Found ${logs.length} Transfer events in ±5 block window`);
for (const log of logs) {
  const data = log.data;
  const amt  = data && data !== "0x" ? BigInt(data) : null;
  const matchesBuyer  = log.topics[1]?.toLowerCase().includes(buyerStripped);
  const matchesSeller = log.topics[2]?.toLowerCase().includes(sellerStripped);
  const matchesAmount = amt === 2000n;
  if (matchesBuyer || matchesSeller || matchesAmount) {
    console.log(`  [MATCH] block=${log.blockNumber} contract=${log.address} tx=${log.transactionHash}`);
    console.log(`    from:   ${log.topics[1]}`);
    console.log(`    to:     ${log.topics[2]}`);
    console.log(`    amount: ${amt}`);
  }
}
console.log("(no output above = no standard ERC-20 Transfer matches buyer/seller/amount)");
