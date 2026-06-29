/**
 * Generate buyer/seller wallet pair and write to .env.local.
 * Mirrors circlefin's arc-nanopayments generate-wallets approach.
 * No network needed — pure viem key generation.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(".env.local");

function replaceOrAppend(content, key, line) {
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(content) ? content.replace(re, line) : content.trimEnd() + "\n" + line;
}

function generateWallet(label) {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`\n${label}`);
  console.log(`  Address:     ${account.address}`);
  console.log(`  Private key: ${privateKey}`);
  return { address: account.address, privateKey };
}

const seller = generateWallet("Seller (receives citation payments)");
const buyer = generateWallet("Buyer (AI agent, pays citations)");

const lines = {
  SELLER_ADDRESS: seller.address,
  SELLER_PRIVATE_KEY: seller.privateKey,
  BUYER_ADDRESS: buyer.address,
  BUYER_PRIVATE_KEY: buyer.privateKey,
};

let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
for (const [key, value] of Object.entries(lines)) {
  content = content ? replaceOrAppend(content, key, `${key}=${value}`) : `${key}=${value}`;
}
writeFileSync(envPath, content.trimEnd() + "\n");

console.log(`\nWritten to ${envPath}`);
console.log(`
Next steps:
  1. Fund the buyer wallet with testnet USDC:
     https://faucet.circle.com/
     Address: ${buyer.address}

  2. Start the server: npm run start:dry   (or npm start for live)

  3. After funding, check balances: npm run check-balances
`);
