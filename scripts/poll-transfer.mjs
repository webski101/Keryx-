import { GatewayClient } from "@circle-fin/x402-batching/client";

const gateway = new GatewayClient({
  chain: "arcTestnet",
  privateKey: process.env.BUYER_PRIVATE_KEY,
});

const id = process.argv[2] ?? "e9ccf6cb-e30c-4f63-ae0d-1060e9135896";

for (let i = 0; i < 20; i++) {
  const t = await gateway.getTransferById(id);
  console.log(`[poll ${i}] status=${t.status}`);
  console.log(JSON.stringify(t, null, 2));
  if (t.status === "completed" || t.status === "failed") break;
  await new Promise(r => setTimeout(r, 5000));
}
