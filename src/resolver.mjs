/**
 * Resolves a Circle transfer UUID to an on-chain Arc Testnet tx hash.
 *
 * Circle batches many x402 payments into periodic GatewayWallet txs.
 * We estimate the target block from the transfer's updatedAt timestamp,
 * then scan ±RADIUS blocks in parallel for a tx to the GatewayWallet contract.
 *
 * If the batch tx isn't on-chain yet (recently settled), we retry until
 * TIMEOUT_MS elapses, waiting RETRY_DELAY_MS between attempts.
 */

import { createPublicClient, http } from "viem";

const GATEWAY_WALLET  = "0x0077777d7eba4688bdef3e311b846f25870a19b9";
const RPC             = "https://rpc.testnet.arc.network";
const ARC_BLOCK_SECS  = 2;    // approximate block time on Arc testnet
const SCAN_RADIUS     = 75;   // blocks either side of estimate
const BATCH_SIZE      = 25;   // parallel RPC calls per batch
const TIMEOUT_MS      = 25_000;
const RETRY_DELAY_MS  = 3_000;

function publicClient() {
  return createPublicClient({ transport: http(RPC) });
}

async function scanWindow(client, centerBlock) {
  const from = centerBlock > SCAN_RADIUS ? centerBlock - SCAN_RADIUS : 1;
  const to   = centerBlock + SCAN_RADIUS;

  const nums = [];
  for (let n = from; n <= to; n++) nums.push(BigInt(n));

  // Fetch in batches to avoid overwhelming the RPC endpoint
  for (let i = 0; i < nums.length; i += BATCH_SIZE) {
    const batch = nums.slice(i, i + BATCH_SIZE);
    const blocks = await Promise.all(
      batch.map(bn =>
        client.getBlock({ blockNumber: bn, includeTransactions: true }).catch(() => null)
      )
    );
    for (const block of blocks) {
      if (!block) continue;
      for (const tx of block.transactions) {
        if (tx.to?.toLowerCase() === GATEWAY_WALLET) {
          return tx.hash;
        }
      }
    }
  }
  return null;
}

/**
 * Returns "https://testnet.arcscan.app/tx/0x..." or null on timeout.
 * @param {string} transferId  Circle transfer UUID
 * @param {object} gateway     GatewayClient instance (already authenticated)
 */
export async function resolveExplorerUrl(transferId, gateway) {
  const deadline = Date.now() + TIMEOUT_MS;

  let targetTs;
  try {
    const transfer = await gateway.getTransferById(transferId);
    if (!transfer?.updatedAt) return null;
    targetTs = Math.floor(new Date(transfer.updatedAt).getTime() / 1000);
    console.log(`[resolver] transfer ${transferId} updatedAt=${transfer.updatedAt}`);
  } catch (e) {
    console.error(`[resolver] getTransferById failed: ${e.message}`);
    return null;
  }

  const client = publicClient();

  while (Date.now() < deadline) {
    try {
      const latest    = await client.getBlock({ blockTag: "latest" });
      const latestTs  = Number(latest.timestamp);
      const latestNum = Number(latest.number);

      const secondsAgo   = Math.max(0, latestTs - targetTs);
      const blocksAgo    = Math.round(secondsAgo / ARC_BLOCK_SECS);
      const centerBlock  = Math.max(1, latestNum - blocksAgo);

      console.log(`[resolver] latest=${latestNum} estimate=${centerBlock} scanning ±${SCAN_RADIUS}`);

      const hash = await scanWindow(client, centerBlock);
      if (hash) {
        const url = `https://testnet.arcscan.app/tx/${hash}`;
        console.log(`[resolver] found: ${url}`);
        return url;
      }
    } catch (e) {
      console.error(`[resolver] scan error: ${e.message}`);
    }

    if (Date.now() + RETRY_DELAY_MS < deadline) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    } else {
      break;
    }
  }

  console.warn(`[resolver] timed out after ${TIMEOUT_MS}ms for transfer ${transferId}`);
  return null;
}
