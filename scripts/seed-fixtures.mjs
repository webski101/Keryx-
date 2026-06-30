/**
 * Register 8 realistic articles for offline demo/testing.
 * Posts to the running server via HTTP so all storage backends work.
 * Re-run safely — same URL → same id, updates in place.
 */

const BASE   = process.env.BASE_URL ?? "http://localhost:3000";
const SELLER = process.env.SELLER_ADDRESS ?? "0xSELLER0000000000000000000000000000000001";

async function reg(article) {
  const r = await fetch(`${BASE}/register`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(article),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? r.statusText);
  return data.id;
}

const articles = [
  {
    url: "https://www.bbc.com/news/technology-67890123",
    title: "OpenAI's GPT-5 Outperforms Doctors in Medical Diagnosis Study",
    priceUsdc: "0.001",
    payTo: SELLER,
    text: `A landmark study published in the New England Journal of Medicine found that OpenAI's latest language model outperformed board-certified physicians in diagnosing rare diseases from patient histories. The model, evaluated on 1,000 de-identified case files, achieved an 87% accuracy rate compared to the 73% average achieved by human clinicians. Researchers cautioned that AI should be viewed as a diagnostic aid rather than a replacement, noting that contextual judgment, physical examination, and patient communication remain irreplaceable components of medical care. The findings have reignited debates about the role of artificial intelligence in clinical settings and prompted calls for regulatory frameworks governing AI-assisted diagnosis.`,
  },
  {
    url: "https://www.theguardian.com/technology/2026/arc-blockchain-payments",
    title: "Arc Blockchain Enables Micropayments at Scale for Content Creators",
    priceUsdc: "0.002",
    payTo: SELLER,
    text: `The Arc blockchain network has processed over 50 million micropayments in its first quarter of operation, enabling content creators to receive fractions of a cent for each piece of content consumed by AI systems. The network uses Circle's USDC stablecoin as its native currency and leverages a batched settlement mechanism that dramatically reduces transaction costs. Publishers who previously relied on ad revenue have begun experimenting with pay-per-citation models, where AI agents pay a small fee each time they ground an answer in a particular source. Early data suggests that high-quality journalism commands higher citation rates, potentially creating market incentives for factual, well-sourced reporting.`,
  },
  {
    url: "https://techcrunch.com/2026/01/15/rss-monetization-ai-agents/",
    title: "RSS Feeds Are Having a Renaissance Thanks to AI Agent Economics",
    priceUsdc: "0.001",
    payTo: SELLER,
    text: `RSS, the technology that powered the early blogosphere before being overshadowed by social media algorithms, is experiencing a surprising revival as the backbone of AI agent content distribution. Platforms like RSSHub already aggregate hundreds of thousands of sources into structured feeds, and new payment layers are turning these feeds into revenue streams. When an AI assistant cites a news article, travel guide, or technical tutorial in its response, the citation can now trigger an automatic micropayment to the original publisher. This permissionless integration means publishers don't need to implement any special technology — they simply maintain their existing RSS feed and receive payments as AI systems consume their content.`,
  },
  {
    url: "https://www.wired.com/story/quantum-computing-cryptography-threat",
    title: "Quantum Computing's Threat to Current Encryption Standards",
    priceUsdc: "0.003",
    payTo: SELLER,
    text: `Cryptographers are racing to develop post-quantum encryption standards as IBM, Google, and a constellation of startups push quantum computing hardware toward practical capability thresholds. The threat model centers on Shor's algorithm, which can theoretically factor large integers exponentially faster than classical computers, rendering RSA and elliptic curve cryptography vulnerable. NIST finalized its first post-quantum cryptographic standards in 2024, selecting CRYSTALS-Kyber for key encapsulation and CRYSTALS-Dilithium for digital signatures. Security researchers recommend organizations begin migration planning now, as retrofitting cryptographic infrastructure across legacy systems typically takes five to ten years. Harvest-now-decrypt-later attacks, where adversaries store encrypted data today to decrypt once quantum capabilities mature, represent an immediate concern for long-lived sensitive information.`,
  },
  {
    url: "https://www.reuters.com/technology/climate-ai-energy-consumption-2026/",
    title: "AI Data Centers Now Consume 3% of Global Electricity, IEA Reports",
    priceUsdc: "0.001",
    payTo: SELLER,
    text: `The International Energy Agency published its annual Digital Economy report showing that artificial intelligence infrastructure now accounts for three percent of global electricity consumption, up from less than one percent in 2022. The explosive growth of large language model training and inference has driven unprecedented demand for data center capacity, with major cloud providers announcing plans for more than 200 gigawatts of new capacity over the next decade. Critics argue that the environmental cost of AI development is being systematically underreported, as companies disclose only direct operational emissions rather than the full supply chain impact of hardware manufacturing. Microsoft, Google, and Amazon have committed to running on 24/7 carbon-free energy by 2030, but analysts note that these pledges depend heavily on nuclear power plants and long-duration storage technologies that remain commercially unproven at scale.`,
  },
  {
    url: "https://apnews.com/article/stablecoin-legislation-congress-2026",
    title: "U.S. Congress Passes Landmark Stablecoin Regulation Framework",
    priceUsdc: "0.002",
    payTo: SELLER,
    text: `The United States Congress passed the Stablecoin Transparency and Accountability for a Better Ledger Economy Act, establishing the first comprehensive federal framework for dollar-backed digital currencies. The legislation requires stablecoin issuers to maintain one-to-one reserves in cash or short-term Treasury securities, submit to monthly audits by registered public accounting firms, and obtain either a federal banking charter or state money transmission license. Circle, the issuer of USDC, welcomed the legislation as providing regulatory clarity that would accelerate institutional adoption. Critics from both the progressive and libertarian wings of Congress raised concerns about barriers to entry for smaller issuers and the potential concentration of stablecoin market share among large financial institutions with existing regulatory relationships.`,
  },
  {
    url: "https://www.nature.com/articles/protein-folding-drug-discovery-2026",
    title: "AlphaFold Derivatives Cut Drug Discovery Timeline by 60 Percent",
    priceUsdc: "0.003",
    payTo: SELLER,
    text: `A consortium of pharmaceutical companies reported that AI-powered protein structure prediction tools derived from DeepMind's AlphaFold have compressed the target identification phase of drug discovery from an average of four years to under eighteen months. The tools predict how candidate drug molecules will interact with disease-associated proteins before any laboratory synthesis, allowing researchers to filter out ineffective compounds computationally rather than through expensive wet lab experiments. Pfizer, Roche, and AstraZeneca have all disclosed that AI-assisted programs have progressed candidates to Phase I clinical trials faster than any previous internal benchmarks. The technology has proven particularly valuable for rare diseases where small patient populations make traditional trial-and-error drug discovery economically unviable.`,
  },
  {
    url: "https://arstechnica.com/ai/2026/autonomous-agent-payment-rails/",
    title: "Autonomous AI Agents Are Learning to Pay Their Own Bills",
    priceUsdc: "0.001",
    payTo: SELLER,
    text: `A new generation of autonomous AI agents is being deployed with dedicated cryptocurrency wallets, enabling them to pay for APIs, data sources, and computational resources without human intervention at each transaction. The payment infrastructure relies on x402, a protocol that extends HTTP with native payment capabilities, allowing agents to encounter a 402 Payment Required response and automatically fulfill the payment condition before retrying the request. Circle's Gateway batching system makes this economically viable by aggregating many small transactions and settling them efficiently on the Arc blockchain network. Early deployments include research agents that pay academic databases per article accessed, coding assistants that license proprietary code snippets, and travel planning agents that pay tourism boards for real-time pricing data.`,
  },
];

console.log(`Registering ${articles.length} articles via ${BASE}...`);
for (const a of articles) {
  const id = await reg(a);
  console.log(`  ✓ [${id}] ${a.title.slice(0, 55)}`);
}
console.log("Done. Run npm run exercise to exercise the breaker rules.");
