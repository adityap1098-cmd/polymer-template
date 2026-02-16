/**
 * Plan Configuration — Adapts bot parameters based on QuickNode plan.
 *
 * Set QUICKNODE_PLAN in .env:
 *   free  → 15 req/s, conservative scanning
 *   paid  → 50 req/s, deep scanning (Build plan $42/mo, 80M credits)
 *
 * All parameters are tuned for each plan to maximize accuracy
 * while staying within API limits.
 */

const PLANS = {
  free: {
    name: 'Free',
    maxRps: 12,              // 80% of 15 req/s limit
    topHolders: 20,          // Solana API returns ~20 max anyway
    txHistoryPerWallet: 50,  // tx to scan for token history
    walletAgePages: 3,       // 3 × 1000 = 3000 tx for age
    fundingHops: 2,          // 2-hop funding chain
    interHolderTxScan: 10,   // last 10 tx per wallet for SOL transfers
    tokenHistoryEarlyStop: 50,  // stop after finding 50 unique tokens
    purchaseTimeScanLimit: 1000, // sigs to scan for first purchase
    description: 'QuickNode Free — 15 req/s, 50K credits/day',
  },
  paid: {
    name: 'Build ($42/mo)',
    maxRps: 40,              // 80% of 50 req/s limit
    topHolders: 20,          // Keep 20 — Solana getTokenLargestAccounts returns max ~20
    txHistoryPerWallet: 200, // 4× deeper token scan → much better Jaccard
    walletAgePages: 5,       // 5 × 1000 = 5000 tx for age
    fundingHops: 4,          // 4-hop deep funding chain (team obfuscation)
    interHolderTxScan: 30,   // last 30 tx per wallet for SOL transfers
    tokenHistoryEarlyStop: 150, // stop after 150 unique tokens
    purchaseTimeScanLimit: 3000, // deeper purchase time scan
    description: 'QuickNode Build — 50 req/s, 80M credits/mo',
  },
};

/**
 * Get plan configuration from environment.
 * @returns {object} Plan config object
 */
export function getPlanConfig() {
  const planKey = (process.env.QUICKNODE_PLAN || 'free').toLowerCase().trim();
  const plan = PLANS[planKey] || PLANS.free;

  // Allow per-param overrides from env
  return {
    ...plan,
    maxRps: parseInt(process.env.MAX_RPS, 10) || plan.maxRps,
    topHolders: parseInt(process.env.TOP_HOLDERS, 10) || plan.topHolders,
    txHistoryPerWallet: parseInt(process.env.TX_HISTORY_PER_WALLET, 10) || plan.txHistoryPerWallet,
    fundingHops: parseInt(process.env.FUNDING_HOPS, 10) || plan.fundingHops,
  };
}

export { PLANS };
