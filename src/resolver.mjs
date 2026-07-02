/**
 * Resolves a settlement timestamp to an on-chain Arc Testnet tx hash.
 *
 * Circle batches many x402 payments into periodic GatewayWallet txs.
 * We estimate the target block from the ms timestamp recorded immediately
 * after gateway.pay() returns, then scan ±RADIUS blocks in parallel for
 * a tx to the GatewayWallet contract.
 *
 * If the batch tx hasn't been mined yet, we retry until TIMEOUT_MS elapses.
 */

import { createPublicClient, http } from "viem";

const GATEWAY_WALLET = "0x0077777d7eba4688bdef3e311b846f25870a19b9";
const RPC            = "https://rpc.testnet.arc.network";
const ARC_BLOCK_SECS = 2;    // approximate block time on Arc testnet
const SCAN_RADIUS    = 75;   // blocks either side of estimate (~150 s of chain)
const BATCH_SIZE     = 25;   // parallel RPC calls per batch
const TIMEOUT_MS     = 25_000;
const RETRY_DELAY_MS = 3_000;

function makeClient() {
  return createPublicClient({ transport: http(RPC) });
}

async function scanWindow(client, centerBlock) {
  const from = centerBlock > SCAN_RADIUS ? centerBlock - SCAN_RADIUS : 1;
  const to   = centerBlock + SCAN_RADIUS;

  const nums = [];
  for (let n = from; n <= to; n++) nums.push(BigInt(n));

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
 * @param {number} settledAtMs  Date.now() recorded right after gateway.pay() resolved
 * @returns {Promise<string|null>}  "https://testnet.arcscan.app/tx/0x..." or null
 */
export async function resolveExplorerUrl(settledAtMs) {
  const targetTs = Math.floor(settledAtMs / 1000);
  const deadline = Date.now() + TIMEOUT_MS;
  const client   = makeClient();

  while (Date.now() < deadline) {
    try {
      const latest    = await client.getBlock({ blockTag: "latest" });
      const latestTs  = Number(latest.timestamp);
      const latestNum = Number(latest.number);

      const secondsAgo  = Math.max(0, latestTs - targetTs);
      const blocksAgo   = Math.round(secondsAgo / ARC_BLOCK_SECS);
      const centerBlock = Math.max(1, latestNum - blocksAgo);

      console.log(`[resolver] latest=${latestNum} target=${centerBlock} scanning ±${SCAN_RADIUS}`);

      const hash = await scanWindow(client, centerBlock);
      if (hash) {
        const url = `https://testnet.arcscan.app/tx/${hash}`;
        console.log(`[resolver] found: ${url}`);
        return url;
      }
    } catch (e) {
      console.error(`[resolver] error: ${e.message}`);
    }

    if (Date.now() + RETRY_DELAY_MS < deadline) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    } else {
      break;
    }
  }

  console.warn(`[resolver] timed out after ${TIMEOUT_MS}ms`);
  return null;
}
