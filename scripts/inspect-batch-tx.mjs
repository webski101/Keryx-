import { createPublicClient, http } from "viem";

const RPC = "https://rpc.testnet.arc.network";
const publicClient = createPublicClient({ transport: http(RPC) });

const hashes = [
  "0x60496e0a86ac3dc5e248bcd8c109dcccec989bd8815601d7fc4a841c7d891fac",
  "0x360dd89321d236cbcd2779801fb2d3ab41f2a6576f08b45cc01158f88e960a95",
];

for (const hash of hashes) {
  const tx = await publicClient.getTransaction({ hash });
  const receipt = await publicClient.getTransactionReceipt({ hash });
  console.log(`\n=== ${hash.slice(0, 18)}... ===`);
  console.log(`  from:     ${tx.from}`);
  console.log(`  to:       ${tx.to}`);
  console.log(`  status:   ${receipt.status}`);
  console.log(`  gasUsed:  ${receipt.gasUsed}`);
  console.log(`  logs:     ${receipt.logs.length}`);
  console.log(`  input(32B): ${tx.input.slice(0, 66)}`);
}
