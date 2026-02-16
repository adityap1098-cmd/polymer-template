/**
 * Plan Configuration — Adapts bot parameters based on QuickNode plan.
 *
 * Set QUICKNODE_PLAN in .env:
 *   free  → 15 req/s, conservative scanning
 *   paid  → 50 req/s, deep scanning (Build plan $42/mo, 80M credits)
 *
 * DAS API features available on both plans:
 *   - getTokenAccounts (paginated holder scan — replaces getProgramAccounts!)
 *   - getAssetsByOwner (richer token/NFT data)
 *   - getAsset / getAssets (token metadata + decimals)
 *   - getTransactionsForAddress (single-call tx fetch, eliminates N+1)
 *   - getMultipleAccounts (batch account lookups)
 *
 * Paid-only features:
 *   - sns_getAllDomainsForOwner (.sol domain detection)
 *   - getProgramAccounts (direct program account scan)
 *
 * All parameters are tuned for each plan to maximize accuracy
 * while staying within API limits.
 */

const PLANS = {
  free: {
    name: 'Discover',
    maxRps: 12,              // 80% of 15 req/s limit
    topHolders: 200,         // DAS getTokenAccounts unlocks ALL holders — analyze top 200
    txHistoryPerWallet: 50,  // tx to scan for token history
    walletAgePages: 3,       // 3 × 1000 = 3000 tx for age
    fundingHops: 2,          // 2-hop funding chain
    interHolderTxScan: 10,   // last 10 tx per wallet for SOL transfers
    tokenHistoryEarlyStop: 50,  // stop after finding 50 unique tokens
    purchaseTimeScanLimit: 1000, // sigs to scan for first purchase

    // DAS API features on Discover plan
    useBatchAccounts: true,  // getMultipleAccounts works on Discover (max 5/call)
    batchAccountsLimit: 5,   // Discover plan: max 5 accounts per getMultipleAccounts call
    useEnhancedTx: true,     // ✅ getTransactionsForAddress works on Discover
    useDAS: true,            // ✅ DAS getAssetsByOwner works on Discover
    useDASTokenAccounts: true, // ✅ DAS getTokenAccounts — paginated ALL holders (replaces getProgramAccounts!)
    useSNS: false,           // ❌ SNS add-on NOT installed — Method not found
    useProgramAccounts: false, // ❌ getProgramAccounts timeout/disabled on Discover
    detectProgramOwned: true,  // PDA detection via getMultipleAccounts (5/call is enough)

    description: 'QuickNode Discover — 15 req/s, DAS getTokenAccounts for full holder scan',
  },
  paid: {
    name: 'Build ($42/mo)',
    maxRps: 40,              // 80% of 50 req/s limit
    topHolders: 200,         // getProgramAccounts unlocks ALL holders — analyze top 200
    txHistoryPerWallet: 200, // 4× deeper token scan → much better Jaccard
    walletAgePages: 5,       // 5 × 1000 = 5000 tx for age
    fundingHops: 4,          // 4-hop deep funding chain (team obfuscation)
    interHolderTxScan: 30,   // last 30 tx per wallet for SOL transfers
    tokenHistoryEarlyStop: 150, // stop after 150 unique tokens
    purchaseTimeScanLimit: 3000, // deeper purchase time scan

    // Enhanced API features (enabled on paid)
    useBatchAccounts: true,  // getMultipleAccounts — saves ~19 calls per analysis
    batchAccountsLimit: 100, // Build plan: max 100 accounts per getMultipleAccounts call
    useEnhancedTx: true,     // getTransactionsForAddress — eliminates N+1 pattern (~50× fewer calls)
    useDAS: true,            // DAS getAssetsByOwner — complete token/NFT profile
    useDASTokenAccounts: true, // DAS getTokenAccounts — paginated ALL holders (preferred over getProgramAccounts)
    useSNS: true,            // SNS .sol domain detection — identity signal for risk scoring
    useProgramAccounts: true, // getProgramAccounts — fallback if DAS getTokenAccounts unavailable
    detectProgramOwned: true, // Check wallet .owner field — catches ALL DEX/Pump.fun PDAs dynamically

    description: 'QuickNode Build — 50 req/s, 80M credits/mo, full DAS + SNS',
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
