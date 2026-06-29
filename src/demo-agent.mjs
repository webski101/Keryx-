/**
 * Shared buyer-agent logic: cite, citeDryRun, citeReal.
 * Used by both the CLI demo script and the dashboard's /demo/cite route.
 */

import { GatewayClient } from "@circle-fin/x402-batching/client";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DRY_RUN = process.env.DRY_RUN === "1";

let _gateway = null;

function getGateway() {
  if (_gateway) return _gateway;
  const privateKey = process.env.BUYER_PRIVATE_KEY;
  if (!privateKey) throw new Error("BUYER_PRIVATE_KEY not set");
  _gateway = new GatewayClient({ chain: "arcTestnet", privateKey });
  return _gateway;
}

/**
 * Cite via dry-run server simulation (no wallet needed).
 */
export async function citeDryRun({ articleId, citedText, payer }) {
  const res = await fetch(`${BASE_URL}/demo/cite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articleId, citedText, payer }),
  });
  return res.json();
}

/**
 * Cite via real GatewayClient (live network, requires BUYER_PRIVATE_KEY).
 */
export async function citeReal({ articleId, citedText }) {
  const gateway = getGateway();
  return gateway.pay(`${BASE_URL}/cite/${articleId}`, {
    method: "POST",
    body: { citedText },
  });
}

/**
 * Auto-dispatch: dry-run or real based on DRY_RUN env.
 */
export async function cite(opts) {
  if (DRY_RUN) return citeDryRun(opts);
  return citeReal(opts);
}
