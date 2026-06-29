/**
 * x402 payment wrapper around BatchFacilitatorClient.
 *
 * DRY_RUN=1 → simulates verify/settle with deterministic fake responses.
 * Otherwise uses the real BatchFacilitatorClient against Arc Testnet.
 */

const DRY_RUN = process.env.DRY_RUN === "1";

const ARC_TESTNET_NETWORK = "eip155:5042002";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

let _facilitator = null;

async function getFacilitator() {
  if (DRY_RUN) return null;
  if (_facilitator) return _facilitator;
  const { BatchFacilitatorClient } = await import("@circle-fin/x402-batching/server");
  _facilitator = new BatchFacilitatorClient();
  return _facilitator;
}

/**
 * Build x402 payment requirements for a specific article.
 * @param {string} payTo  - seller wallet address
 * @param {string} priceUsdc - e.g. "0.001"
 */
export function buildPaymentRequirements(payTo, priceUsdc) {
  const amount = Math.round(parseFloat(priceUsdc) * 1_000_000).toString();
  return {
    scheme: "exact",
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount,
    payTo,
    maxTimeoutSeconds: 604900, // 7 days + 100s buffer — Circle Gateway minimum
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
    },
  };
}

/**
 * Verify a payment payload.
 * Returns { isValid, payer?, invalidReason? }
 */
export async function verify(payload, requirements) {
  if (DRY_RUN) {
    // Simulate: accept any payload that contains a "payer" field
    const payer = payload?.payer ?? payload?.payload?.from ?? "0xDEAD000000000000000000000000000000000001";
    return { isValid: true, payer };
  }
  const facilitator = await getFacilitator();
  return facilitator.verify(payload, requirements);
}

/**
 * Settle a payment.
 * Returns { success, transaction?, payer?, errorReason? }
 */
export async function settle(payload, requirements) {
  if (DRY_RUN) {
    const payer = payload?.payer ?? payload?.payload?.from ?? "0xDEAD000000000000000000000000000000000001";
    const fakeTx = "0xdry" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
    return { success: true, transaction: fakeTx, payer };
  }
  const facilitator = await getFacilitator();
  try {
    return await facilitator.settle(payload, requirements);
  } catch (e) {
    // Retry once on transient TLS/socket errors (ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC,
    // UND_ERR_SOCKET, ECONNRESET). These are network glitches, not logic errors.
    const transient = e.code === "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC"
      || e.code === "UND_ERR_SOCKET"
      || e.code === "ECONNRESET"
      || (e.cause?.code === "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC")
      || (e.cause?.code === "UND_ERR_SOCKET");
    if (transient) {
      console.error(`[settle] transient network error (${e.code ?? e.cause?.code}), retrying in 1 s…`);
      await new Promise(r => setTimeout(r, 1000));
      return facilitator.settle(payload, requirements);
    }
    throw e;
  }
}

export { DRY_RUN };
