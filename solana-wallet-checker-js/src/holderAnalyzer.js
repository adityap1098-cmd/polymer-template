/**
 * Holder Analyzer Module — Enhanced with Modern Analysis Methods.
 * 
 * Modern techniques implemented:
 * 1. Jaccard Similarity Coefficient (replaces naive common-count)
 * 2. Gini Coefficient for holder concentration analysis
 * 3. Buy-Timing Correlation (detect coordinated purchases)
 * 4. Wallet Age & Activity Frequency scoring
 * 5. Enhanced 7-factor Risk Scoring (max 100)
 * 6. Token Health Overview Metrics
 * 
 * References: Bubblemaps, Arkham Intelligence, GMGN, RugCheck
 */

import { PublicKey } from '@solana/web3.js';
import { RateLimitedRPC } from './rateLimiter.js';
import {
  EXCHANGE_WALLETS, LIQUIDITY_PROGRAMS, UNIVERSAL_TOKENS,
  identifyExchange, isLiquidityProgram, isUniversalToken, getEntityLabel,
  KNOWN_PROGRAM_LABELS, SYSTEM_PROGRAM_ID, getProgramLabel, isUserWallet,
} from './knownEntities.js';
import { extractEntryPriceFromTx } from './priceAnalyzer.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './utils.js';

/**
 * Format a percentage for display. Handles very small values nicely.
 * @param {number} pct - percentage value (e.g., 2.08 or 0.000068)
 * @returns {string}
 */
function fmtPct(pct) {
  if (pct >= 0.01) return pct.toFixed(2) + '%';
  if (pct >= 0.0001) return pct.toFixed(4) + '%';
  if (pct > 0) return '<0.0001%';
  return '0%';
}

/** Shorten a Solana address for display: first 6 + last 4 */
function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || '?';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

/** Bubble size character based on supply percentage */
function bubbleChar(pct) {
  if (pct >= 5) return '⬤';
  if (pct >= 1) return '◉';
  if (pct >= 0.5) return '●';
  return '○';
}

/**
 * Check if a Solana address is on the Ed25519 curve.
 * On-curve = could be a real user wallet (has a private key).
 * Off-curve = guaranteed PDA (Program Derived Address) = not a human.
 *
 * This is a FREE, instant, zero-RPC check — pure math.
 * Solana explorers show this as "isOnCurve: True/False" in account info.
 *
 * @param {string} address - Base58 Solana address
 * @returns {boolean} true if on-curve (possible user), false if off-curve (PDA)
 */
export function checkIsOnCurve(address) {
  try {
    const pubkey = new PublicKey(address);
    return PublicKey.isOnCurve(pubkey.toBytes());
  } catch {
    return false; // invalid address = treat as non-user
  }
}

// ─── Math Utilities ─────────────────────────────────────────────────────────

/**
 * Calculate Gini Coefficient for a list of values.
 * 0 = perfect equality, 1 = maximum inequality.
 * Used by modern tools to assess holder concentration.
 */
export function calculateGini(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  if (mean === 0) return 0;

  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (2 * (i + 1) - n - 1) * sorted[i];
  }
  return numerator / (n * n * mean);
}

/**
 * Jaccard Similarity Coefficient between two sets.
 * J(A,B) = |A ∩ B| / |A ∪ B|
 * 0 = no overlap, 1 = identical sets.
 * More robust than simple common-count threshold.
 */
export function jaccardSimilarity(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ─── Main Class ─────────────────────────────────────────────────────────────

export class HolderAnalyzer {
  /**
   * @param {string} rpcUrl - Solana RPC endpoint URL
   * @param {object} [config] - Plan configuration (from planConfig.js)
   */
  constructor(rpcUrl, config = {}) {
    this.rpcUrl = rpcUrl;
    this.config = {
      maxRps: config.maxRps || 12,
      txHistoryPerWallet: config.txHistoryPerWallet || 50,
      walletAgePages: config.walletAgePages || 3,
      tokenHistoryEarlyStop: config.tokenHistoryEarlyStop || 50,
      purchaseTimeScanLimit: config.purchaseTimeScanLimit || 1000,
      holderConcurrency: config.holderConcurrency || 3,
      useBatchAccounts: config.useBatchAccounts || false,
      useEnhancedTx: config.useEnhancedTx || false,
      useDAS: config.useDAS || false,
      useDASTokenAccounts: config.useDASTokenAccounts || false,
      useSNS: config.useSNS || false,
      useProgramAccounts: config.useProgramAccounts || false,
      detectProgramOwned: config.detectProgramOwned || false,
      batchAccountsLimit: config.batchAccountsLimit || 5,
    };
    this.rpc = new RateLimitedRPC(rpcUrl, this.config.maxRps);
  }

  // ─── Token Holders Fetch ────────────────────────────────────────────────

  /**
   * Get top token holders for a token mint.
   * @param {string} tokenMint
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getTokenHolders(tokenMint, limit = 50) {
    console.log(`\n🔍 Fetching holders for ${tokenMint.slice(0, 12)}...`);

    // ── Fetch REAL total supply (critical for accurate percentages) ──
    let totalSupply = 0;
    try {
      const supplyResult = await this.rpc.call('getTokenSupply', [tokenMint]);
      if (supplyResult?.value) {
        totalSupply = parseFloat(supplyResult.value.uiAmountString || supplyResult.value.uiAmount || '0');
      }
      // totalSupply logged in report, not here
    } catch { /* will fall back to sum of analyzed holders */ }

    let rawAccounts = []; // Array of { tokenAccount, owner, balance (raw), decimals }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: Get top token holders
    //   Step 1: getTokenLargestAccounts → top ~20 by balance (ALWAYS, guaranteed correct)
    //   Step 2: If limit > 20, EXPAND via DAS getTokenAccounts or getProgramAccounts
    //
    //   NOTE: DAS getTokenAccounts returns holders in ARBITRARY order (often smallest
    //   first), so it CANNOT be the primary method for "top holder" analysis.
    //   getTokenLargestAccounts is the ONLY method that returns sorted-by-balance.
    // ═══════════════════════════════════════════════════════════════════

    // ── Step 1: getTokenLargestAccounts (ALWAYS — guaranteed correct top ~20) ──
    // Fetch top holders (quiet mode — minimal logs)
    try {
      const largest = await this.rpc.call('getTokenLargestAccounts', [tokenMint]);
      if (!largest || !largest.value || largest.value.length === 0) {
        console.log('  ⚠️ getTokenLargestAccounts returned no accounts');
      } else {
        const accounts = largest.value;
        // resolved silently

        // Resolve token accounts → owner wallets
        let resolved = false;
        if (this.config.useBatchAccounts) {
          const BATCH_LIMIT = this.config.batchAccountsLimit;
          // batch resolve owners
          const addresses = accounts.map(a => a.address).filter(Boolean);
          const amounts = new Map(accounts.map(a => [a.address, parseFloat(a.amount || '0')]));

          try {
            for (let b = 0; b < addresses.length; b += BATCH_LIMIT) {
              const chunk = addresses.slice(b, b + BATCH_LIMIT);
              const batchResult = await this.rpc.call('getMultipleAccounts', [
                chunk, { encoding: 'jsonParsed' },
              ]);

              if (batchResult?.value) {
                for (let i = 0; i < batchResult.value.length; i++) {
                  const acctData = batchResult.value[i];
                  const address = chunk[i];
                  const amount = amounts.get(address) || 0;
                  if (!acctData || amount <= 0) continue;

                  const parsed = acctData.data?.parsed || {};
                  const info = parsed.info || {};
                  const owner = info.owner;
                  if (!owner || owner.length < 32) continue;

                  const decimals = info.tokenAmount?.decimals || 0;
                  rawAccounts.push({ tokenAccount: address, owner, balance: amount, decimals });
                }
              }
            }
            if (rawAccounts.length > 0) resolved = true;
          } catch (err) {
            console.log(`  ⚠️ getMultipleAccounts failed (${err.message}), falling back to sequential`);
          }
        }

        // Sequential fallback
        if (!resolved) {
          for (let i = 0; i < accounts.length; i++) {
            try {
              const accountInfo = accounts[i];
              const address = accountInfo.address;
              const amount = parseFloat(accountInfo.amount || '0');
              if (!address || amount <= 0) continue;

              const accountData = await this.rpc.call('getAccountInfo', [
                address, { encoding: 'jsonParsed' },
              ]);
              if (!accountData || !accountData.value) continue;
              const parsed = accountData.value?.data?.parsed || {};
              const info = parsed.info || {};
              const owner = info.owner;
              if (!owner || owner.length < 32) continue;

              const decimals = info.tokenAmount?.decimals || 0;
              rawAccounts.push({ tokenAccount: address, owner, balance: amount, decimals });

              // progress tracked silently
            } catch { continue; }
          }
        }

        rawAccounts.sort((a, b) => b.balance - a.balance);
      }
    } catch (err) {
      console.log(`  ⚠️ getTokenLargestAccounts failed: ${err.message}`);
    }

    // ── Step 2: Expand beyond top 20 if user requested more ──
    //   getTokenLargestAccounts caps at ~20 accounts. If limit > resolved,
    //   use DAS (all pages, sort locally) or getProgramAccounts to find more.
    if (rawAccounts.length > 0 && rawAccounts.length < limit) {
      const existingOwners = new Set(rawAccounts.map(a => a.owner));
      const existingTokenAccounts = new Set(rawAccounts.map(a => a.tokenAccount));

      // ── DAS: getTokenAccounts (paginated, fetch ALL to sort correctly) ──
      if (this.config.useDASTokenAccounts) {
        // DAS expansion (quiet)
        try {
          // Get token decimals via DAS getAsset
          let tokenDecimals = 0;
          try {
            const assetInfo = await this.rpc.call('getAsset', {
              id: tokenMint,
              displayOptions: { showFungible: true },
            });
            tokenDecimals = assetInfo?.token_info?.decimals || 0;
          } catch { /* will use 0 decimals */ }

          // Fetch ALL pages to sort locally (DAS doesn't sort by balance)
          // Cap at 50 pages (50k accounts) to avoid excessive RPC calls
          const MAX_PAGES = 50;
          let page = 1;
          let hasMore = true;
          const dasAccounts = [];

          while (hasMore && page <= MAX_PAGES) {
            const result = await this.rpc.call('getTokenAccounts', {
              mintAddress: tokenMint,
              page,
              limit: 1000,
            });

            const accounts = result?.token_accounts;
            if (!accounts || !Array.isArray(accounts) || accounts.length === 0) break;

            for (const acct of accounts) {
              if (!acct.owner) continue;
              const amount = parseFloat(acct.amount || '0');
              if (amount <= 0) continue;
              // Skip accounts already resolved from getTokenLargestAccounts
              if (existingOwners.has(acct.owner) || existingTokenAccounts.has(acct.address)) continue;
              dasAccounts.push({
                tokenAccount: acct.address,
                owner: acct.owner,
                balance: amount,
                decimals: tokenDecimals,
              });
            }

            if (accounts.length < 1000) {
              hasMore = false;
            } else {
              page++;
            }
          }

          if (dasAccounts.length > 0) {
            // Sort DAS results by balance descending
            dasAccounts.sort((a, b) => b.balance - a.balance);
            // Take only what we need to reach limit (× 3 headroom for filtering)
            const needed = Math.max((limit - rawAccounts.length) * 3, 50);
            const topDas = dasAccounts.slice(0, needed);
            rawAccounts.push(...topDas);
            rawAccounts.sort((a, b) => b.balance - a.balance);
            // DAS expanded
          } else {
            // no additional DAS holders
          }
        } catch (err) {
          console.log(`  ⚠️ DAS getTokenAccounts failed (${err.message})`);
        }
      }

      // ── getProgramAccounts (Build/paid plan only) ──
      if (this.config.useProgramAccounts && rawAccounts.length < limit) {
        // getProgramAccounts expansion (quiet)
        try {
          const result = await this.rpc.call('getProgramAccounts', [
            TOKEN_PROGRAM_ID,
            {
              filters: [
                { dataSize: 165 },
                { memcmp: { offset: 0, bytes: tokenMint } },
              ],
              encoding: 'jsonParsed',
            },
          ]);

          if (result && Array.isArray(result) && result.length > 0) {
            // getProgramAccounts success
            const programAccounts = [];
            for (const entry of result) {
              const info = entry.account?.data?.parsed?.info;
              if (!info || !info.owner) continue;
              const amount = parseFloat(info.tokenAmount?.amount || '0');
              if (amount <= 0) continue;
              if (existingOwners.has(info.owner)) continue;
              programAccounts.push({
                tokenAccount: entry.pubkey,
                owner: info.owner,
                balance: amount,
                decimals: info.tokenAmount?.decimals || 0,
              });
            }

            // Also check Token-2022 program
            try {
              const result2022 = await this.rpc.call('getProgramAccounts', [
                TOKEN_2022_PROGRAM_ID,
                {
                  filters: [
                    { dataSize: 165 },
                    { memcmp: { offset: 0, bytes: tokenMint } },
                  ],
                  encoding: 'jsonParsed',
                },
              ]);
              if (result2022 && Array.isArray(result2022)) {
                for (const entry of result2022) {
                  const info = entry.account?.data?.parsed?.info;
                  if (!info || !info.owner) continue;
                  const amount = parseFloat(info.tokenAmount?.amount || '0');
                  if (amount <= 0) continue;
                  if (existingOwners.has(info.owner)) continue;
                  programAccounts.push({
                    tokenAccount: entry.pubkey,
                    owner: info.owner,
                    balance: amount,
                    decimals: info.tokenAmount?.decimals || 0,
                  });
                }
              }
            } catch { /* Token-2022 not applicable for this mint */ }

            if (programAccounts.length > 0) {
              programAccounts.sort((a, b) => b.balance - a.balance);
              rawAccounts.push(...programAccounts);
              rawAccounts.sort((a, b) => b.balance - a.balance);
              // expansion merged silently
            }
          }
        } catch (err) {
          console.log(`  ⚠️ getProgramAccounts failed: ${err.message}`);
        }
      }
    }

    // ── Fallback: If getTokenLargestAccounts failed, try DAS or getProgramAccounts as primary ──
    if (rawAccounts.length === 0) {
      // fallback silently

      // Try DAS as primary fallback (fetch all pages, sort locally)
      if (this.config.useDASTokenAccounts) {
        // DAS fallback
        try {
          let tokenDecimals = 0;
          try {
            const assetInfo = await this.rpc.call('getAsset', {
              id: tokenMint,
              displayOptions: { showFungible: true },
            });
            tokenDecimals = assetInfo?.token_info?.decimals || 0;
          } catch { /* will use 0 decimals */ }

          const MAX_PAGES = 50;
          let page = 1;
          let hasMore = true;

          while (hasMore && page <= MAX_PAGES) {
            const result = await this.rpc.call('getTokenAccounts', {
              mintAddress: tokenMint,
              page,
              limit: 1000,
            });

            const accounts = result?.token_accounts;
            if (!accounts || !Array.isArray(accounts) || accounts.length === 0) break;

            for (const acct of accounts) {
              if (!acct.owner) continue;
              const amount = parseFloat(acct.amount || '0');
              if (amount <= 0) continue;
              rawAccounts.push({
                tokenAccount: acct.address,
                owner: acct.owner,
                balance: amount,
                decimals: tokenDecimals,
              });
            }

            if (accounts.length < 1000) {
              hasMore = false;
            } else {
              page++;
            }
          }

          if (rawAccounts.length > 0) {
            rawAccounts.sort((a, b) => b.balance - a.balance);
            // DAS fallback complete
          }
        } catch (err) {
          console.log(`  ⚠️ DAS fallback failed: ${err.message}`);
          rawAccounts = [];
        }
      }

      // Try getProgramAccounts as last resort
      if (this.config.useProgramAccounts && rawAccounts.length === 0) {
        // getProgramAccounts fallback
        try {
          const result = await this.rpc.call('getProgramAccounts', [
            TOKEN_PROGRAM_ID,
            {
              filters: [
                { dataSize: 165 },
                { memcmp: { offset: 0, bytes: tokenMint } },
              ],
              encoding: 'jsonParsed',
            },
          ]);

          if (result && Array.isArray(result) && result.length > 0) {
            for (const entry of result) {
              const info = entry.account?.data?.parsed?.info;
              if (!info || !info.owner) continue;
              const amount = parseFloat(info.tokenAmount?.amount || '0');
              if (amount <= 0) continue;
              rawAccounts.push({
                tokenAccount: entry.pubkey,
                owner: info.owner,
                balance: amount,
                decimals: info.tokenAmount?.decimals || 0,
              });
            }
            rawAccounts.sort((a, b) => b.balance - a.balance);
            // getProgramAccounts fallback complete
          }
        } catch (err) {
          console.log(`  ⚠️ getProgramAccounts fallback failed: ${err.message}`);
        }
      }
    }

    if (rawAccounts.length === 0) {
      console.log('No token accounts resolved');
      return [];
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2: Filter known static entities (exchanges, liquidity programs)
    // ═══════════════════════════════════════════════════════════════════

    const holders = [];
    const filteredEntities = [];
    const unknownOwners = []; // owners we need to PDA-check in Phase 3

    for (const acct of rawAccounts) {
      const { owner, balance, decimals, tokenAccount } = acct;

      // Static check: known liquidity program
      if (isLiquidityProgram(owner)) {
        const uiAmount = decimals > 0 ? balance / Math.pow(10, decimals) : balance;
        const label = getEntityLabel(owner) || '🔄 Liquidity/DEX';
        filteredEntities.push({ owner, type: 'LIQUIDITY', label, balance: uiAmount });
        continue;
      }

      // Static check: known exchange
      const exchange = identifyExchange(owner);
      if (exchange.isExchange) {
        const uiAmount = decimals > 0 ? balance / Math.pow(10, decimals) : balance;
        filteredEntities.push({ owner, type: 'EXCHANGE', label: `🏦 ${exchange.name}`, balance: uiAmount });
        continue;
      }

      const uiAmount = decimals > 0 ? balance / Math.pow(10, decimals) : balance;
      holders.push({ owner, balance: uiAmount, tokenAccount });
      unknownOwners.push(owner);
    }

    // static filter done

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2.5: isOnCurve Instant PDA Filter (FREE — zero RPC calls)
    //   PublicKey.isOnCurve() checks if address is on Ed25519 curve.
    //   Off-curve = guaranteed PDA = not a human wallet.
    //   This is the same "isOnCurve: False" shown on Solscan/Solana Explorer.
    //   Filters obvious PDAs BEFORE expensive RPC batch calls.
    // ═══════════════════════════════════════════════════════════════════

    {
      const offCurveHolders = [];
      const onCurveHolders = [];

      for (const holder of holders) {
        if (checkIsOnCurve(holder.owner)) {
          onCurveHolders.push(holder);
        } else {
          offCurveHolders.push(holder);
        }
      }

      if (offCurveHolders.length > 0) {
        // isOnCurve filter done
        for (const holder of offCurveHolders) {
          filteredEntities.push({
            owner: holder.owner,
            type: 'PDA_CURVE',
            label: '🤖 PDA (off-curve)',
            balance: holder.balance,
          });
        }

        // Keep only on-curve holders for further analysis
        holders.length = 0;
        holders.push(...onCurveHolders);

        // Also update unknownOwners to only include on-curve wallets
        unknownOwners.length = 0;
        unknownOwners.push(...onCurveHolders.map(h => h.owner));

        // on-curve wallets identified
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2.7: Pre-limit — only check top N wallets in Phase 3
    //   When DAS expansion or getProgramAccounts returns many holders,
    //   we only need to PDA-check the top candidates (by balance).
    //   Use limit × 3 to have headroom for PDA filtering.
    // ═══════════════════════════════════════════════════════════════════

    if (holders.length > limit * 3) {
      holders.sort((a, b) => b.balance - a.balance);
      const preLimit = limit * 3;
      // pre-limited for efficiency
      holders.length = preLimit;
      unknownOwners.length = 0;
      unknownOwners.push(...holders.map(h => h.owner));
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 3: Dynamic PDA Detection — check wallet program ownership
    //   For on-curve wallets, verify via getMultipleAccounts that
    //   wallet.owner === System Program. Identifies program-owned
    //   accounts that happen to be on-curve (rare but possible).
    //   Also labels the specific program (Pump.fun, Raydium, etc.)
    // ═══════════════════════════════════════════════════════════════════

    if (this.config.detectProgramOwned && unknownOwners.length > 0) {
      // PDA batch verification

      const pdaDetected = new Map(); // owner → { programId, label }

      // Also collect off-curve PDA addresses to upgrade their labels
      // Only upgrade labels if there aren't too many (avoid wasting RPC calls)
      const offCurvePDAs = filteredEntities.length <= 200
        ? filteredEntities.filter(e => e.type === 'PDA_CURVE').map(e => e.owner)
        : [];
      const allToCheck = [...new Set([...unknownOwners, ...offCurvePDAs])];

      // Batch check using getMultipleAccounts (chunk size respects plan limit)
      const BATCH_SIZE = this.config.batchAccountsLimit;

      for (let i = 0; i < allToCheck.length; i += BATCH_SIZE) {
        const batch = allToCheck.slice(i, i + BATCH_SIZE);
        try {
          const batchResult = await this.rpc.call('getMultipleAccounts', [
            batch, { encoding: 'jsonParsed' },
          ]);

          if (batchResult?.value) {
            for (let j = 0; j < batchResult.value.length; j++) {
              const acctInfo = batchResult.value[j];
              const walletAddr = batch[j];
              if (!acctInfo) continue;

              const ownerProgram = acctInfo.owner;
              if (!ownerProgram) continue;

              // System Program = real user wallet → skip
              if (isUserWallet(ownerProgram)) continue;

              // Not System Program → this is a PDA
              const programLabel = getProgramLabel(ownerProgram);
              const label = programLabel || `🤖 PDA (${ownerProgram.slice(0, 8)}...)`;
              pdaDetected.set(walletAddr, { programId: ownerProgram, label });
            }
          }
        } catch (err) {
          console.log(`  ⚠️ PDA batch check failed: ${err.message}`);
        }
      }

      if (pdaDetected.size > 0) {

        // Upgrade labels of off-curve PDAs that were generic "🤖 PDA (off-curve)"
        for (const ent of filteredEntities) {
          if (ent.type === 'PDA_CURVE' && pdaDetected.has(ent.owner)) {
            const info = pdaDetected.get(ent.owner);
            ent.label = info.label;  // upgrade from generic to specific (e.g., "🐸 Pump.fun Bonding Curve")
            ent.programId = info.programId;
          }
        }

        // Move PDA wallets from holders to filteredEntities
        const newHolders = [];
        for (const holder of holders) {
          const pdaInfo = pdaDetected.get(holder.owner);
          if (pdaInfo) {
            filteredEntities.push({
              owner: holder.owner,
              type: 'PDA',
              label: pdaInfo.label,
              balance: holder.balance,
              programId: pdaInfo.programId,
            });
          } else {
            newHolders.push(holder);
          }
        }
        holders.length = 0;
        holders.push(...newHolders);
      }
    }

    if (filteredEntities.length > 0) {
      console.log(`  🔍 Filtered: ${filteredEntities.length} non-human entities`);
    }

    if (holders.length === 0) return { holders: [], filteredEntities };
    // After filtering — count shown in main progress

    holders.sort((a, b) => b.balance - a.balance);
    const topHolders = holders.slice(0, limit);
    console.log(`Analyzing top ${topHolders.length} holders...`);

    // Get purchase time + entry price + wallet age + token holdings
    // Parallel batched: process CONCURRENCY holders at a time
    const CONCURRENCY = this.config.holderConcurrency;
    for (let batch = 0; batch < topHolders.length; batch += CONCURRENCY) {
      const chunk = topHolders.slice(batch, batch + CONCURRENCY);
      const promises = chunk.map(async (holder, localIdx) => {
        const i = batch + localIdx;
        try {
          const purchaseInfo = await this._getFirstPurchaseTime(holder.owner, tokenMint);
          topHolders[i].purchaseTime = purchaseInfo?.purchaseTime || null;
          topHolders[i].purchaseTimeStr = purchaseInfo?.purchaseTime
            ? purchaseInfo.purchaseTime.toISOString().replace('T', ' ').split('.')[0]
            : 'Unknown';

          // Entry price data from purchase transaction
          if (purchaseInfo?.entryPrice) {
            topHolders[i].entryPriceSol = purchaseInfo.entryPrice.pricePerToken;
            topHolders[i].solSpent = purchaseInfo.entryPrice.solSpent;
            topHolders[i].tokensReceived = purchaseInfo.entryPrice.tokensReceived;
          } else {
            topHolders[i].entryPriceSol = null;
            topHolders[i].solSpent = null;
            topHolders[i].tokensReceived = null;
          }

          // Wallet age & activity metrics (paginated — finds TRUE oldest tx)
          const walletAge = await this._getWalletAge(holder.owner);
          topHolders[i].walletAgeDays = walletAge.ageDays;
          topHolders[i].txFrequency = walletAge.txPerDay;
          topHolders[i].totalTxCount = walletAge.totalTx;

          // Token holdings — combine CURRENT accounts + HISTORICAL tx scan
          const tokenData = await this._getWalletTokenAccounts(holder.owner, tokenMint);
          const historicalTokens = await this._getWalletTokenHistory(holder.owner, tokenMint, this.config.txHistoryPerWallet);
          const combinedTokens = new Set([...tokenData.allTokens, ...historicalTokens]);
          topHolders[i].tradedTokens = combinedTokens;
          topHolders[i].tokenCount = tokenData.tokenCount;
          topHolders[i].historicalTokenCount = combinedTokens.size;
        } catch {
          topHolders[i].purchaseTime = null;
          topHolders[i].purchaseTimeStr = 'Unknown';
          topHolders[i].entryPriceSol = null;
          topHolders[i].solSpent = null;
          topHolders[i].tokensReceived = null;
          topHolders[i].walletAgeDays = null;
          topHolders[i].txFrequency = 0;
          topHolders[i].totalTxCount = 0;
          topHolders[i].tradedTokens = new Set();
          topHolders[i].tokenCount = 0;
          topHolders[i].historicalTokenCount = 0;
        }
      });
      await Promise.all(promises);

      // Log progress after each batch
      const lastIdx = Math.min(batch + CONCURRENCY, topHolders.length) - 1;
      const curr = topHolders[lastIdx].tokenCount || 0;
      const hist = topHolders[lastIdx].historicalTokenCount || 0;
      const ep = topHolders[lastIdx].entryPriceSol;
      const epStr = ep != null && ep > 0 ? ` entry=${ep.toExponential(2)}SOL` : '';
      // progress tracked by batch
    }

    const stats = this.rpc.getStats();
    console.log(`✅ Done! (${stats.totalRequests} RPC calls, ${stats.totalErrors} rate limits hit)`);
    return { holders: topHolders, filteredEntities, totalSupply };
  }

  // ─── Wallet Age Analysis ────────────────────────────────────────────────

  /**
   * Get wallet age in days and activity frequency.
   * Paginates up to 3 pages (3000 txs) to find the TRUE oldest transaction.
   * Modern tools use this to filter fresh snipers vs organic holders.
   */
  async _getWalletAge(wallet) {
    try {
      let oldestBlockTime = null;
      let newestBlockTime = null;
      let totalTx = 0;
      let before = undefined;
      const MAX_PAGES = this.config.walletAgePages; // configurable: 3 (free) or 5 (paid)

      for (let page = 0; page < MAX_PAGES; page++) {
        const opts = { limit: 1000 };
        if (before) opts.before = before;

        const sigs = await this.rpc.call('getSignaturesForAddress', [wallet, opts]);
        if (!sigs || sigs.length === 0) break;

        totalTx += sigs.length;

        // First page, first entry = newest tx
        if (page === 0 && sigs[0]?.blockTime) {
          newestBlockTime = sigs[0].blockTime;
        }

        // Last entry of this page = oldest so far
        const lastSig = sigs[sigs.length - 1];
        if (lastSig?.blockTime) {
          oldestBlockTime = lastSig.blockTime;
        }

        // If fewer than 1000, we've reached the end
        if (sigs.length < 1000) break;
        before = lastSig.signature;
      }

      if (!oldestBlockTime) return { ageDays: 0, txPerDay: 0, totalTx };

      const nowSec = Date.now() / 1000;
      const ageDays = Math.max(1, (nowSec - oldestBlockTime) / 86400);

      const activeDays = (newestBlockTime && oldestBlockTime !== newestBlockTime)
        ? Math.max(1, (newestBlockTime - oldestBlockTime) / 86400)
        : 1;
      const txPerDay = totalTx / activeDays;

      return { ageDays: Math.round(ageDays), txPerDay: Math.round(txPerDay * 100) / 100, totalTx };
    } catch {
      return { ageDays: null, txPerDay: 0, totalTx: 0 };
    }
  }

  // ─── Token Accounts (Direct Query) ──────────────────────────────────────

  /**
   * Get wallet's current token holdings using getTokenAccountsByOwner.
   * Much more accurate than parsing transaction history.
   * Returns: { allTokens: Set, heldTokens: Set, tokenCount: number }
   */
  async _getWalletTokenAccounts(wallet, excludeToken = null) {
    const allTokens = new Set();   // all mints found (for Jaccard)
    const heldTokens = new Set();  // mints with balance > 0 (for token count)

    // ── Enhanced: Try DAS getAssetsByOwner first (paid plan) ──
    if (this.config.useDAS) {
      try {
        const dasResult = await this.rpc.call('getAssetsByOwner', [{
          ownerAddress: wallet,
          page: 1,
          limit: 1000,
          displayOptions: { showFungible: true, showNativeBalance: false },
        }]);

        if (dasResult?.items && dasResult.items.length > 0) {
          for (const item of dasResult.items) {
            // DAS returns token_info for fungible tokens
            const mint = item.id;
            if (!mint || mint === excludeToken) continue;
            if (isUniversalToken(mint)) continue;

            // Filter by interface: FungibleToken, FungibleAsset
            const iface = item.interface;
            if (iface !== 'FungibleToken' && iface !== 'FungibleAsset') continue;

            allTokens.add(mint);
            const balance = item.token_info?.balance || 0;
            if (balance > 0) heldTokens.add(mint);
          }

          if (allTokens.size > 0) {
            return { allTokens, heldTokens, tokenCount: heldTokens.size };
          }
        }
      } catch { /* DAS failed, fall through to standard method */ }
    }

    // ── Standard: getTokenAccountsByOwner ──
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        const result = await this.rpc.call('getTokenAccountsByOwner', [
          wallet,
          { programId },
          { encoding: 'jsonParsed' },
        ]);
        if (result?.value) {
          for (const acct of result.value) {
            const info = acct.account?.data?.parsed?.info;
            if (!info?.mint) continue;
            const mint = info.mint;
            if (mint === excludeToken) continue;
            if (isUniversalToken(mint)) continue;

            allTokens.add(mint);
            const amount = parseFloat(info.tokenAmount?.uiAmount || '0');
            if (amount > 0) heldTokens.add(mint);
          }
        }
      } catch { /* skip program */ }
    }

    return { allTokens, heldTokens, tokenCount: heldTokens.size };
  }

  // ─── Token Trading History (Deep Scan) ──────────────────────────────────

  /**
   * Extract token mints from a transaction object.
   * Shared helper for both legacy (getTransaction) and enhanced (getTransactionsForAddress).
   * @private
   */
  _extractTokenMintsFromTx(tx, wallet, excludeToken) {
    const mints = new Set();
    if (!tx?.meta) return mints;

    // Extract from preTokenBalances + postTokenBalances (most reliable)
    for (const balances of [tx.meta.preTokenBalances, tx.meta.postTokenBalances]) {
      if (!balances) continue;
      for (const b of balances) {
        if (b.mint && b.owner === wallet && b.mint !== excludeToken && !isUniversalToken(b.mint)) {
          mints.add(b.mint);
        }
      }
    }

    // Also check inner instructions for additional mints
    for (const innerGroup of (tx.meta.innerInstructions || [])) {
      for (const inst of (innerGroup.instructions || [])) {
        const programId = inst.programId?.toString?.() || inst.programId;
        if (programId === TOKEN_PROGRAM_ID || programId === TOKEN_2022_PROGRAM_ID) {
          const mint = inst.parsed?.info?.mint;
          if (mint && mint !== excludeToken && !isUniversalToken(mint)) mints.add(mint);
        }
      }
    }

    return mints;
  }

  /**
   * Get ALL tokens a wallet has interacted with from transaction history.
   * CRITICAL: getTokenAccountsByOwner misses closed accounts (sold tokens).
   * This scans recent N transactions to find every token mint the wallet touched.
   * Combined with getTokenAccountsByOwner, gives a COMPLETE token profile.
   *
   * Enhanced path: getTransactionsForAddress returns full txs in ONE call (paid plan).
   * Legacy path: getSignaturesForAddress + N × getTransaction (N+1 calls).
   *
   * @param {string} wallet
   * @param {string} excludeToken — the token being analyzed
   * @param {number} limit — number of recent txs to scan (default: 50)
   * @returns {Promise<Set<string>>}
   */
  async _getWalletTokenHistory(wallet, excludeToken = null, limit = null) {
    const tokens = new Set();
    const scanLimit = limit || this.config.txHistoryPerWallet;
    const earlyStop = this.config.tokenHistoryEarlyStop;

    // ── Enhanced: getTransactionsForAddress (single call, paid plan) ──
    if (this.config.useEnhancedTx) {
      try {
        const txs = await this.rpc.call('getTransactionsForAddress', [
          wallet, { limit: scanLimit, encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
        ]);

        if (Array.isArray(txs) && txs.length > 0) {
          for (const tx of txs) {
            const mints = this._extractTokenMintsFromTx(tx, wallet, excludeToken);
            for (const m of mints) tokens.add(m);
            if (tokens.size >= earlyStop) break;
          }
          return tokens; // Success — skip legacy path
        }
      } catch { /* Enhanced method unavailable, fall through to legacy */ }
    }

    // ── Legacy: getSignaturesForAddress + getTransaction (N+1 calls) ──
    try {
      const signatures = await this.rpc.call('getSignaturesForAddress', [wallet, { limit: scanLimit }]);
      if (!signatures || !Array.isArray(signatures)) return tokens;

      for (const sigInfo of signatures) {
        if (!sigInfo.signature) continue;

        try {
          const tx = await this.rpc.call('getTransaction', [
            sigInfo.signature,
            { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
          ]);

          const mints = this._extractTokenMintsFromTx(tx, wallet, excludeToken);
          for (const m of mints) tokens.add(m);
        } catch { continue; }

        // Early stop: found enough tokens for meaningful Jaccard comparison
        if (tokens.size >= earlyStop) break;
      }
    } catch { /* empty */ }

    return tokens;
  }

  // ─── Buy Timing Correlation ─────────────────────────────────────────────

  /**
   * Detect wallets that purchased within a short time window of each other.
   * Modern sybil detection technique used by GMGN, Bubblemaps.
   * 
   * @param {Array} holders - Must have purchaseTime set
   * @param {number} windowMinutes - Time window to consider "coordinated" (default: 5)
   * @returns {Array<TimingCluster>}
   */
  analyzeTimingCorrelation(holders, windowMinutes = 5) {
    const withTime = holders.filter(h => h.purchaseTime instanceof Date);
    if (withTime.length < 2) return [];

    // Sort by purchase time
    withTime.sort((a, b) => a.purchaseTime.getTime() - b.purchaseTime.getTime());

    const windowMs = windowMinutes * 60 * 1000;
    const clusters = [];
    const visited = new Set();

    for (let i = 0; i < withTime.length; i++) {
      if (visited.has(i)) continue;

      const cluster = [i];
      visited.add(i);
      const baseTime = withTime[i].purchaseTime.getTime();

      for (let j = i + 1; j < withTime.length; j++) {
        if (visited.has(j)) continue;
        const diff = withTime[j].purchaseTime.getTime() - baseTime;
        if (diff <= windowMs) {
          cluster.push(j);
          visited.add(j);
        } else {
          break; // sorted, no more can match
        }
      }

      if (cluster.length >= 2) {
        const wallets = cluster.map(idx => withTime[idx]);
        const times = wallets.map(w => w.purchaseTime.getTime());
        const spreadSec = Math.round((Math.max(...times) - Math.min(...times)) / 1000);

        clusters.push({
          wallets: wallets.map(w => w.owner),
          count: wallets.length,
          spreadSeconds: spreadSec,
          earliest: new Date(Math.min(...times)),
          latest: new Date(Math.max(...times)),
        });
      }
    }

    return clusters;
  }

  // ─── Jaccard Similarity Analysis ────────────────────────────────────────

  /**
   * Analyze trading pattern similarities using Jaccard Coefficient.
   * Modern approach: uses J(A,B) instead of raw common count.
   * 
   * @param {Array} holders
   * @param {string} currentToken
   * @returns {Promise<object>}
   */
  async analyzeHolderSimilarities(holders, currentToken) {
    // Similarity analysis

    // Use pre-fetched token data from getTokenHolders, or fetch if missing
    let fetchedCount = 0;
    let cachedCount = 0;
    for (let i = 0; i < holders.length; i++) {
      if (holders[i].tradedTokens && holders[i].tradedTokens.size > 0) {
        cachedCount++;
      } else {
        // Fallback: combined current + historical
        try {
          const tokenData = await this._getWalletTokenAccounts(holders[i].owner, currentToken);
          const historical = await this._getWalletTokenHistory(holders[i].owner, currentToken);
          holders[i].tradedTokens = new Set([...tokenData.allTokens, ...historical]);
          holders[i].tokenCount = tokenData.tokenCount;
          holders[i].historicalTokenCount = holders[i].tradedTokens.size;
          fetchedCount++;
        } catch {
          holders[i].tradedTokens = new Set();
          holders[i].tokenCount = 0;
        }
      }
    }

    // similarity data ready

    // Compute pairwise Jaccard similarities
    const similarities = new Map();

    for (let i = 0; i < holders.length; i++) {
      const tokens1 = holders[i].tradedTokens || new Set();
      if (tokens1.size === 0) continue;

      for (let j = i + 1; j < holders.length; j++) {
        const tokens2 = holders[j].tradedTokens || new Set();
        if (tokens2.size === 0) continue;

        const jaccard = jaccardSimilarity(tokens1, tokens2);
        const commonTokens = new Set([...tokens1].filter(t => tokens2.has(t)));

        // Smart threshold: proportional overlap required
        // Jaccard ≥ 0.08 with 3+ common = significant proportional overlap
        // For large portfolios: raw count ≥ 8 AND ≥ 5% of smaller portfolio
        const minPortfolio = Math.min(tokens1.size, tokens2.size);
        const commonPct = minPortfolio > 0 ? commonTokens.size / minPortfolio : 0;
        const passesJaccard = jaccard >= 0.08 && commonTokens.size >= 3;
        const passesRawCount = commonTokens.size >= 8 && commonPct >= 0.05;
        if (passesJaccard || passesRawCount) {
          const key = [holders[i].owner, holders[j].owner].sort().join('|');
          similarities.set(key, {
            wallets: [holders[i].owner, holders[j].owner],
            jaccard: Math.round(jaccard * 1000) / 1000,
            commonTokens,
            commonCount: commonTokens.size,
          });
        }
      }
    }

    const walletGroups = this._groupSimilarWallets(holders, similarities);

    // Timing correlation
    const timingClusters = this.analyzeTimingCorrelation(holders);

    return {
      holderCount: holders.length,
      similarities,
      groups: walletGroups,
      totalGroups: walletGroups.length,
      timingClusters,
      totalTimingClusters: timingClusters.length,
    };
  }

  // ─── Enhanced Risk Scoring (7 factors) ──────────────────────────────────

  /**
   * Calculate risk score for a holder using 7 modern factors.
   * 
   * Factors:
   * 1. Token Diversity       (0-15 pts) — less weight than before
   * 2. Holder Concentration   (0-20 pts)
   * 3. Coordinated Activity   (0-20 pts) — uses Jaccard
   * 4. Wallet Age            (0-15 pts) — NEW: fresh wallets = higher risk
   * 5. Buy Timing            (0-10 pts) — NEW: coordinated timing
   * 6. Funding Pattern       (0-10 pts) — NEW: sybil funding
   * 7. Behavioral Anomaly    (0-10 pts) — enhanced suspicious patterns
   * 
   * Total: 0-100
   */
  calculateRiskScore(holder, allHolders, similarityAnalysis = null, fundingAnalysis = null, totalSupply = 0) {
    let riskScore = 0;
    const riskFactors = [];
    const wallet = holder.owner;
    const balance = holder.balance;
    const tokenCount = holder.tokenCount || 0;

    // Use real totalSupply if available, otherwise fall back to sum of analyzed holders
    const effectiveSupply = totalSupply > 0 ? totalSupply : allHolders.reduce((sum, h) => sum + h.balance, 0);
    const holderPercentage = effectiveSupply > 0 ? (balance / effectiveSupply * 100) : 0;

    // ── Factor 1: Token Diversity (0-15 pts) ──
    if (tokenCount === 0) {
      riskScore += 15;
      riskFactors.push('❌ No trading history (15pts)');
    } else if (tokenCount <= 2) {
      riskScore += 12;
      riskFactors.push(`⚠️  Very low diversity: ${tokenCount} tokens (12pts)`);
    } else if (tokenCount <= 5) {
      riskScore += 6;
      riskFactors.push(`📊 Limited diversity: ${tokenCount} tokens (6pts)`);
    }

    // ── Factor 2: Holder Concentration (0-20 pts) ──
    if (holderPercentage >= 10) {
      riskScore += 20;
      riskFactors.push(`🐋 Whale: ${holderPercentage.toFixed(2)}% of supply (20pts)`);
    } else if (holderPercentage >= 5) {
      riskScore += 14;
      riskFactors.push(`📊 Large holder: ${holderPercentage.toFixed(2)}% (14pts)`);
    } else if (holderPercentage >= 2) {
      riskScore += 7;
      riskFactors.push(`📈 Notable holder: ${holderPercentage.toFixed(2)}% (7pts)`);
    }

    // ── Factor 3: Coordinated Activity — Jaccard (0-20 pts) ──
    if (similarityAnalysis && similarityAnalysis.groups) {
      for (const group of similarityAnalysis.groups) {
        if (group.wallets.includes(wallet)) {
          const avgJaccard = group.avgJaccard || 0;
          const walletCount = group.walletCount;

          if (avgJaccard >= 0.4 && walletCount >= 3) {
            riskScore += 20;
            riskFactors.push(`🚨 High coordination: J=${avgJaccard.toFixed(2)}, ${walletCount} wallets (20pts)`);
          } else if (avgJaccard >= 0.25 || walletCount >= 2) {
            riskScore += 14;
            riskFactors.push(`⚠️  Moderate coordination: J=${avgJaccard.toFixed(2)}, ${walletCount} wallets (14pts)`);
          } else if (avgJaccard >= 0.15) {
            riskScore += 7;
            riskFactors.push(`ℹ️  Possible coordination: J=${avgJaccard.toFixed(2)}, ${walletCount} wallets (7pts)`);
          }
          break;
        }
      }
    }

    // ── Factor 4: Wallet Age (0-15 pts) ──
    const ageDays = holder.walletAgeDays;
    if (ageDays !== null && ageDays !== undefined) {
      if (ageDays <= 1) {
        riskScore += 15;
        riskFactors.push(`🆕 Brand new wallet: ${ageDays} day(s) old (15pts)`);
      } else if (ageDays <= 7) {
        riskScore += 10;
        riskFactors.push(`📅 Very young wallet: ${ageDays} days old (10pts)`);
      } else if (ageDays <= 30) {
        riskScore += 5;
        riskFactors.push(`📅 Young wallet: ${ageDays} days old (5pts)`);
      }
    }

    // ── Factor 5: Buy Timing Correlation (0-10 pts) ──
    if (similarityAnalysis && similarityAnalysis.timingClusters) {
      for (const cluster of similarityAnalysis.timingClusters) {
        if (cluster.wallets.includes(wallet)) {
          if (cluster.spreadSeconds <= 30) {
            riskScore += 10;
            riskFactors.push(`⏱️  Bought within ${cluster.spreadSeconds}s of ${cluster.count - 1} others (10pts)`);
          } else if (cluster.spreadSeconds <= 120) {
            riskScore += 7;
            riskFactors.push(`⏱️  Bought within ${Math.round(cluster.spreadSeconds / 60)}min of ${cluster.count - 1} others (7pts)`);
          } else {
            riskScore += 4;
            riskFactors.push(`⏱️  Bought within ${Math.round(cluster.spreadSeconds / 60)}min of ${cluster.count - 1} others (4pts)`);
          }
          break;
        }
      }
    }

    // ── Factor 6: Funding Pattern (0-10 pts) ──
    if (fundingAnalysis) {
      // Check if wallet is in a sybil cluster
      for (const cluster of (fundingAnalysis.clusters || [])) {
        if (cluster.wallets.includes(wallet)) {
          if (cluster.type === 'INTER_HOLDER_FUNDING') {
            riskScore += 10;
            riskFactors.push(`💰 Funded by another holder in this token (10pts)`);
          } else {
            riskScore += 8;
            riskFactors.push(`💰 Same funder as ${cluster.walletCount - 1} other holder(s) (8pts)`);
          }
          break;
        }
      }
      // Check sniper pattern
      for (const sniper of (fundingAnalysis.sniperPatterns || [])) {
        if (sniper.wallet === wallet) {
          riskScore += 5;
          riskFactors.push(`🎯 Funded ${sniper.minutesBetween}min before purchase (5pts)`);
          break;
        }
      }
    }

    // ── Factor 7: Behavioral Anomaly (0-10 pts) ──
    if (balance > 1000000 && tokenCount <= 1) {
      riskScore += 10;
      riskFactors.push('🔍 Whale with no trading history (10pts)');
    } else if (holder.txFrequency && holder.txFrequency > 50) {
      riskScore += 7;
      riskFactors.push(`🤖 Bot-like activity: ${holder.txFrequency} tx/day (7pts)`);
    } else if (balance < 100 && tokenCount >= 10) {
      riskScore += 5;
      riskFactors.push('🔍 Tiny holder with high activity (5pts)');
    }

    // Cap at 100
    riskScore = Math.min(100, riskScore);

    let riskLevel, riskDescription;
    if (riskScore >= 70) {
      riskLevel = '🔴 CRITICAL';
      riskDescription = 'High risk — likely manipulation or sybil';
    } else if (riskScore >= 50) {
      riskLevel = '🟠 HIGH';
      riskDescription = 'Significant risk indicators present';
    } else if (riskScore >= 30) {
      riskLevel = '🟡 MEDIUM';
      riskDescription = 'Some risk factors detected';
    } else {
      riskLevel = '🟢 LOW';
      riskDescription = 'Normal holder behavior';
    }

    return { score: riskScore, level: riskLevel, description: riskDescription, factors: riskFactors, holderPercentage };
  }

  // ─── Token Health Metrics ───────────────────────────────────────────────

  /**
   * Calculate comprehensive token health metrics.
   * @param {Array} holders
   * @param {object} similarityAnalysis
   * @param {object} fundingAnalysis
   * @returns {object}
   */
  calculateTokenHealth(holders, similarityAnalysis = null, fundingAnalysis = null, totalSupply = 0) {
    const balances = holders.map(h => h.balance);
    const totalBalance = balances.reduce((s, v) => s + v, 0);
    // Use real totalSupply for concentration metrics (fall back to sum of analyzed)
    const effectiveSupply = totalSupply > 0 ? totalSupply : totalBalance;

    // Gini coefficient
    const gini = calculateGini(balances);

    // Top holder concentration
    const sorted = [...balances].sort((a, b) => b - a);
    const top5Pct = effectiveSupply > 0 ? (sorted.slice(0, 5).reduce((s, v) => s + v, 0) / effectiveSupply * 100) : 0;
    const top10Pct = effectiveSupply > 0 ? (sorted.slice(0, 10).reduce((s, v) => s + v, 0) / effectiveSupply * 100) : 0;

    // Average wallet age
    const ages = holders.filter(h => h.walletAgeDays != null).map(h => h.walletAgeDays);
    const avgWalletAge = ages.length > 0 ? Math.round(ages.reduce((s, v) => s + v, 0) / ages.length) : null;
    const freshWallets = ages.filter(a => a <= 7).length;

    // Timing clusters
    const timingClusterCount = similarityAnalysis?.totalTimingClusters || 0;
    const walletsInTimingClusters = (similarityAnalysis?.timingClusters || [])
      .reduce((sum, c) => sum + c.count, 0);

    // Sybil clusters
    const sybilClusterCount = fundingAnalysis?.totalClusters || 0;
    const walletsInSybil = (fundingAnalysis?.clusters || [])
      .reduce((sum, c) => sum + c.walletCount, 0);

    // Overall token risk
    let tokenRiskScore = 0;
    if (gini >= 0.8) tokenRiskScore += 25;
    else if (gini >= 0.6) tokenRiskScore += 15;
    else if (gini >= 0.4) tokenRiskScore += 5;

    if (top5Pct >= 50) tokenRiskScore += 20;
    else if (top5Pct >= 30) tokenRiskScore += 10;

    if (freshWallets / Math.max(1, holders.length) >= 0.5) tokenRiskScore += 15;
    else if (freshWallets / Math.max(1, holders.length) >= 0.3) tokenRiskScore += 8;

    if (timingClusterCount >= 3) tokenRiskScore += 15;
    else if (timingClusterCount >= 1) tokenRiskScore += 8;

    if (sybilClusterCount >= 2) tokenRiskScore += 15;
    else if (sybilClusterCount >= 1) tokenRiskScore += 8;

    tokenRiskScore = Math.min(100, tokenRiskScore);

    let tokenRiskLevel;
    if (tokenRiskScore >= 60) tokenRiskLevel = '🔴 HIGH RISK';
    else if (tokenRiskScore >= 35) tokenRiskLevel = '🟡 MODERATE RISK';
    else tokenRiskLevel = '🟢 LOW RISK';

    return {
      gini: Math.round(gini * 1000) / 1000,
      top5Concentration: Math.round(top5Pct * 100) / 100,
      top10Concentration: Math.round(top10Pct * 100) / 100,
      avgWalletAge,
      freshWallets,
      timingClusterCount,
      walletsInTimingClusters,
      sybilClusterCount,
      walletsInSybil,
      tokenRiskScore,
      tokenRiskLevel,
    };
  }

  // ─── Wallet Grouping ───────────────────────────────────────────────────

  /**
   * Group similar wallets using BFS. Enhanced: stores avg Jaccard.
   */
  _groupSimilarWallets(holders, similarities) {
    const walletConnections = new Map();
    const pairJaccards = new Map();

    for (const [, data] of similarities) {
      const wallets = data.wallets;
      for (const wallet of wallets) {
        if (!walletConnections.has(wallet)) walletConnections.set(wallet, new Set());
        for (const w of wallets) {
          if (w !== wallet) walletConnections.get(wallet).add(w);
        }
      }
      const key = wallets.sort().join('|');
      pairJaccards.set(key, data.jaccard);
    }

    const visited = new Set();
    const groups = [];

    for (const wallet of walletConnections.keys()) {
      if (visited.has(wallet)) continue;

      const group = new Set();
      const queue = [wallet];

      while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current)) continue;
        visited.add(current);
        group.add(current);

        if (walletConnections.has(current)) {
          for (const connected of walletConnections.get(current)) {
            if (!visited.has(connected)) queue.push(connected);
          }
        }
      }

      if (group.size >= 2) {
        const groupArr = [...group];
        const groupHolders = holders.filter(h => group.has(h.owner));

        // Calculate avg Jaccard within group
        let totalJaccard = 0;
        let pairCount = 0;
        for (let i = 0; i < groupArr.length; i++) {
          for (let j = i + 1; j < groupArr.length; j++) {
            const key = [groupArr[i], groupArr[j]].sort().join('|');
            if (pairJaccards.has(key)) {
              totalJaccard += pairJaccards.get(key);
              pairCount++;
            }
          }
        }
        const avgJaccard = pairCount > 0 ? totalJaccard / pairCount : 0;

        // Common tokens (intersection of all)
        const tradedSets = groupHolders
          .filter(h => h.tradedTokens && h.tradedTokens.size > 0)
          .map(h => h.tradedTokens);

        let commonTokens = new Set();
        if (tradedSets.length >= 2) {
          commonTokens = tradedSets.reduce((acc, curr) => new Set([...acc].filter(t => curr.has(t))));
          // Remove universal tokens from common set — they inflate similarity falsely
          for (const t of commonTokens) {
            if (isUniversalToken(t)) commonTokens.delete(t);
          }
        }

        groups.push({
          wallets: groupArr,
          walletCount: group.size,
          avgJaccard: Math.round(avgJaccard * 1000) / 1000,
          commonTokens: [...commonTokens].slice(0, 10),
          commonTokenCount: commonTokens.size,
        });
      }
    }

    groups.sort((a, b) => b.walletCount - a.walletCount);
    return groups;
  }

  // ─── First Purchase Time ────────────────────────────────────────────────

  async _getFirstPurchaseTime(wallet, tokenMint) {
    try {
      const scanLimit = this.config.purchaseTimeScanLimit;

      // ── Enhanced: try getTransactionsForAddress for fast purchase detection ──
      if (this.config.useEnhancedTx) {
        try {
          // Fetch a moderate batch to find earliest purchase
          const txs = await this.rpc.call('getTransactionsForAddress', [
            wallet, { limit: Math.min(scanLimit, 200), encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
          ]);

          if (Array.isArray(txs) && txs.length > 0) {
            // Sort oldest first (by slot or blockTime)
            const sorted = [...txs].sort((a, b) => (a.slot || 0) - (b.slot || 0));

            for (const tx of sorted.slice(0, 20)) {
              if (!tx?.meta) continue;
              for (const balance of (tx.meta.postTokenBalances || [])) {
                if (balance.mint === tokenMint && balance.owner === wallet) {
                  const bt = tx.blockTime;
                  // Extract entry price from the purchase transaction
                  const entryPrice = extractEntryPriceFromTx(tx, wallet, tokenMint);
                  return {
                    purchaseTime: bt ? new Date(bt * 1000) : new Date(),
                    entryPrice,
                  };
                }
              }
            }
            return null; // Searched but not found — skip legacy
          }
        } catch { /* fall through to legacy */ }
      }

      // ── Legacy: getSignaturesForAddress + getTransaction ──
      const signatures = await this.rpc.call('getSignaturesForAddress', [wallet, { limit: scanLimit }]);
      if (!signatures || !Array.isArray(signatures) || signatures.length === 0) return null;

      // Sort ascending (oldest first)
      signatures.sort((a, b) => (a.slot || 0) - (b.slot || 0));

      // Check up to 20 oldest transactions for the token purchase
      for (const sigInfo of signatures.slice(0, 20)) {
        const signature = sigInfo.signature;
        const blockTime = sigInfo.blockTime;
        if (!signature) continue;

        try {
          const tx = await this.rpc.call('getTransaction', [
            signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
          ]);
          if (!tx || !tx.meta) continue;

          for (const balance of (tx.meta.postTokenBalances || [])) {
            if (balance.mint === tokenMint && balance.owner === wallet) {
              // Extract entry price from the purchase transaction
              const entryPrice = extractEntryPriceFromTx(tx, wallet, tokenMint);
              return {
                purchaseTime: blockTime ? new Date(blockTime * 1000) : new Date(),
                entryPrice,
              };
            }
          }
        } catch { continue; }
      }
      return null;
    } catch { return null; }
  }

  // ─── Enhanced Output Formatter ──────────────────────────────────────────

  /**
   * Format comprehensive analysis report.
   * @param {Array} holders
   * @param {string} tokenMint
   * @param {object|null} similarityAnalysis
   * @param {object|null} fundingAnalysis
   * @returns {string}
   */
  formatHoldersOutput(holders, tokenMint, similarityAnalysis = null, fundingAnalysis = null, filteredEntities = [], totalSupply = 0) {
    const lines = [];

    // Compute risk scores
    for (const holder of holders) {
      holder.riskData = this.calculateRiskScore(holder, holders, similarityAnalysis, fundingAnalysis, totalSupply);
    }

    // Token Health Overview
    const health = this.calculateTokenHealth(holders, similarityAnalysis, fundingAnalysis, totalSupply);
    const totalBalance = holders.reduce((sum, h) => sum + h.balance, 0);
    // Use real totalSupply for all percentage calculations
    const effectiveSupply = totalSupply > 0 ? totalSupply : totalBalance;
    const sorted = [...holders].sort((a, b) => b.riskData.score - a.riskData.score);
    const riskSummary = { '🔴 CRITICAL': 0, '🟠 HIGH': 0, '🟡 MEDIUM': 0, '🟢 LOW': 0 };
    for (const holder of holders) riskSummary[holder.riskData.level]++;

    // Calculate sybil controlled %
    const sybilWallets = new Set();
    if (fundingAnalysis?.clusters) {
      for (const c of fundingAnalysis.clusters) c.wallets.forEach(w => sybilWallets.add(w));
    }
    const sybilBalance = holders.filter(h => sybilWallets.has(h.owner)).reduce((s, h) => s + h.balance, 0);
    const sybilPct = effectiveSupply > 0 ? (sybilBalance / effectiveSupply * 100) : 0;

    // Calculate similarity controlled %
    const simWallets = new Set();
    if (similarityAnalysis?.groups) {
      for (const g of similarityAnalysis.groups) g.wallets.forEach(w => simWallets.add(w));
    }
    const simBalance = holders.filter(h => simWallets.has(h.owner)).reduce((s, h) => s + h.balance, 0);
    const simPct = effectiveSupply > 0 ? (simBalance / effectiveSupply * 100) : 0;

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 1: HEADER + QUICK VERDICT
    // ═══════════════════════════════════════════════════════════════════
    lines.push('');
    lines.push('╔' + '═'.repeat(78) + '╗');
    lines.push('║  TOKEN HOLDER RISK ANALYSIS                                                  ║');
    lines.push('╚' + '═'.repeat(78) + '╝');
    lines.push(`  Token:  ${tokenMint}`);
    lines.push(`  Date:   ${new Date().toISOString().replace('T', ' ').split('.')[0]} UTC`);
    lines.push('');

    // ── QUICK VERDICT ──
    lines.push('┌' + '─'.repeat(78) + '┐');
    lines.push('│  ⚡ QUICK VERDICT                                                            │');
    lines.push('├' + '─'.repeat(78) + '┤');
    lines.push(`│  Overall:   ${health.tokenRiskLevel} (${health.tokenRiskScore}/100)`);
    lines.push(`│  Holders:   ${holders.length} analyzed${filteredEntities.length > 0 ? `, ${filteredEntities.length} filtered (exchanges/DEX/bots)` : ''}`);
    lines.push(`│  Gini:      ${health.gini} ${health.gini >= 0.7 ? '⚠️  HIGHLY CONCENTRATED' : health.gini >= 0.4 ? '— moderate concentration' : '— well distributed'}`);
    lines.push(`│  Top 5:     ${fmtPct(health.top5Concentration)} of supply`);
    lines.push(`│  Fresh:     ${health.freshWallets}/${holders.length} wallets ≤7 days old (${(health.freshWallets / Math.max(1, holders.length) * 100).toFixed(0)}%)`);
    if (health.sybilClusterCount > 0) {
      lines.push(`│  Sybil:     ${health.sybilClusterCount} cluster(s) — ${health.walletsInSybil} wallets control ${fmtPct(sybilPct)}`);
    }
    if (similarityAnalysis?.totalGroups > 0) {
      lines.push(`│  Similar:   ${similarityAnalysis.totalGroups} group(s) — ${simWallets.size} wallets share trading patterns (${fmtPct(simPct)})`);
    }
    if (health.timingClusterCount > 0) {
      lines.push(`│  Timing:    ${health.timingClusterCount} cluster(s) — coordinated buys detected`);
    }
    lines.push('│');

    // Verdict text
    const critHigh = riskSummary['🔴 CRITICAL'] + riskSummary['🟠 HIGH'];
    let verdict;
    if (health.tokenRiskScore >= 60) {
      verdict = '🚨 HIGH RISK — Kemungkinan besar ada manipulasi. Hati-hati!';
    } else if (health.tokenRiskScore >= 35) {
      verdict = '⚠️  MODERATE — Ada indikasi risiko. Perlu investigasi lebih lanjut.';
    } else {
      verdict = '✅ LOW RISK — Distribusi holder terlihat normal.';
    }
    lines.push(`│  📋 ${verdict}`);
    lines.push('└' + '─'.repeat(78) + '┘');
    lines.push('');

    // ── FILTERED ENTITIES (compact — names only, no raw addresses) ──
    if (filteredEntities && filteredEntities.length > 0) {
      lines.push('🔍 FILTERED (excluded from analysis):');
      for (const ent of filteredEntities) {
        const balStr = ent.balance > 0 ? ` — ${ent.balance.toLocaleString('en-US', { minimumFractionDigits: 0 })} tokens` : '';
        // Show label/name ONLY — no wallet address (user requested)
        lines.push(`   ${ent.label}${balStr}`);
      }
      lines.push('');
    }

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 2: RISK DISTRIBUTION + SUPPLY BAR
    // ═══════════════════════════════════════════════════════════════════
    const analyzedPct = effectiveSupply > 0 ? (totalBalance / effectiveSupply * 100) : 100;
    const barFull = Math.round(analyzedPct / 100 * 30);
    const supplyBar = '█'.repeat(barFull) + '░'.repeat(30 - barFull);
    lines.push(`  ${supplyBar} ${analyzedPct.toFixed(1)}% of supply analyzed`);
    lines.push(`  📊 Risk: 🔴 ${riskSummary['🔴 CRITICAL']} Critical | 🟠 ${riskSummary['🟠 HIGH']} High | 🟡 ${riskSummary['🟡 MEDIUM']} Medium | 🟢 ${riskSummary['🟢 LOW']} Low`);
    lines.push('');

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 3: 🗺️ BUBBLE MAP — Holder Network Visualization
    // ═══════════════════════════════════════════════════════════════════
    const hasSybil = fundingAnalysis?.clusters?.length > 0;
    const hasSimilarity = similarityAnalysis?.groups?.length > 0;
    const hasTiming = similarityAnalysis?.timingClusters?.length > 0;

    if (hasSybil || hasSimilarity || hasTiming) {
      lines.push('╔' + '═'.repeat(78) + '╗');
      lines.push('║  🗺️  BUBBLE MAP — Holder Connections                                         ║');
      lines.push('╚' + '═'.repeat(78) + '╝');
      lines.push('  Legend: ⬤ >5%  ◉ 1-5%  ● 0.5-1%  ○ <0.5%    Risk: 🔴≥70  🟠≥50  🟡≥30  🟢<30');
      lines.push('');

      const assignedWallets = new Set();

      // ── Sybil clusters (strongest signal — shared funder) ──
      if (hasSybil) {
        for (let i = 0; i < fundingAnalysis.clusters.length; i++) {
          const cluster = fundingAnalysis.clusters[i];
          const clusterBal = holders.filter(h => cluster.wallets.includes(h.owner))
            .reduce((s, h) => s + h.balance, 0);
          const clusterPct = effectiveSupply > 0 ? (clusterBal / effectiveSupply * 100) : 0;

          const funderLabel = cluster.funder ? (getEntityLabel(cluster.funder) || '') : '';
          const funderShort = cluster.funder ? shortAddr(cluster.funder) : '?';
          const typeStr = cluster.type === 'INTER_HOLDER_FUNDING'
            ? '⚠️  Inter-holder funding'
            : `${funderLabel || funderShort}`;

          lines.push(`  ── CLUSTER ${String.fromCharCode(65 + i)}: ${typeStr} ── ${fmtPct(clusterPct)} supply ──`);
          lines.push('  │');

          const walletInfos = cluster.wallets
            .map(w => ({ wallet: w, holder: holders.find(h => h.owner === w) }))
            .filter(x => x.holder)
            .sort((a, b) => b.holder.balance - a.holder.balance);

          for (let wi = 0; wi < walletInfos.length; wi++) {
            const { wallet, holder: hi } = walletInfos[wi];
            const pct = effectiveSupply > 0 ? (hi.balance / effectiveSupply * 100) : 0;
            const risk = hi.riskData || { level: '🟢 LOW', score: 0 };
            const riskIcon = risk.level.split(' ')[0];
            const connector = wi === walletInfos.length - 1 ? '└──' : '├──';
            lines.push(`  ${connector} ${bubbleChar(pct)} ${fmtPct(pct).padEnd(7)} ${shortAddr(wallet)}  ${riskIcon}${risk.score}`);
            assignedWallets.add(wallet);
          }
          lines.push('');
        }
      }

      // ── Similarity groups (only those not fully covered by sybil) ──
      if (hasSimilarity) {
        let simIdx = 0;
        for (const group of similarityAnalysis.groups) {
          // Skip if all wallets already shown in sybil clusters
          const unshown = group.wallets.filter(w => !assignedWallets.has(w));
          if (unshown.length === 0) continue;

          simIdx++;
          const groupBal = holders.filter(h => group.wallets.includes(h.owner))
            .reduce((s, h) => s + h.balance, 0);
          const groupPct = effectiveSupply > 0 ? (groupBal / effectiveSupply * 100) : 0;

          let jLabel;
          if (group.avgJaccard >= 0.8) jLabel = '🔴 IDENTICAL';
          else if (group.avgJaccard >= 0.4) jLabel = '🟠 HIGH';
          else jLabel = '🟡 MODERATE';

          const sharedStr = group.commonTokenCount > 0
            ? `, ${group.commonTokenCount} shared tokens` : '';
          lines.push(`  ── SIMILAR #${simIdx}: J=${group.avgJaccard} ${jLabel}${sharedStr} ── ${fmtPct(groupPct)} supply ──`);
          lines.push('  │');

          const walletInfos = group.wallets
            .map(w => ({ wallet: w, holder: holders.find(h => h.owner === w) }))
            .filter(x => x.holder)
            .sort((a, b) => b.holder.balance - a.holder.balance);

          for (let wi = 0; wi < walletInfos.length; wi++) {
            const { wallet, holder: hi } = walletInfos[wi];
            const pct = effectiveSupply > 0 ? (hi.balance / effectiveSupply * 100) : 0;
            const risk = hi.riskData || { level: '🟢 LOW', score: 0 };
            const riskIcon = risk.level.split(' ')[0];
            const inSybil = assignedWallets.has(wallet) ? ' *' : '';
            const connector = wi === walletInfos.length - 1 ? '└──' : '├──';
            lines.push(`  ${connector} ${bubbleChar(pct)} ${fmtPct(pct).padEnd(7)} ${shortAddr(wallet)}  ${riskIcon}${risk.score}${inSybil}`);
            assignedWallets.add(wallet);
          }
          lines.push('');
        }
      }

      // ── Timing clusters ──
      if (hasTiming) {
        for (let ti = 0; ti < similarityAnalysis.timingClusters.length; ti++) {
          const tc = similarityAnalysis.timingClusters[ti];
          const spreadStr = tc.spreadSeconds < 60
            ? `${tc.spreadSeconds}s` : `${Math.round(tc.spreadSeconds / 60)}min`;
          lines.push(`  ── TIMING #${ti + 1}: ${tc.count} wallets within ${spreadStr} ──`);
          lines.push('  │');
          for (let wi = 0; wi < tc.wallets.length; wi++) {
            const wallet = tc.wallets[wi];
            const hi = holders.find(h => h.owner === wallet);
            const pct = hi && effectiveSupply > 0 ? (hi.balance / effectiveSupply * 100) : 0;
            const connector = wi === tc.wallets.length - 1 ? '└──' : '├──';
            lines.push(`  ${connector} ${bubbleChar(pct)} ${fmtPct(pct).padEnd(7)} ${shortAddr(wallet)}`);
          }
          lines.push('');
        }
      }

      // ── Unlinked holders summary ──
      const unlinkedHolders = holders
        .filter(h => !assignedWallets.has(h.owner))
        .sort((a, b) => b.balance - a.balance);
      if (unlinkedHolders.length > 0) {
        const unlinkedBal = unlinkedHolders.reduce((s, h) => s + h.balance, 0);
        const unlinkedPct = effectiveSupply > 0 ? (unlinkedBal / effectiveSupply * 100) : 0;
        lines.push(`  ── UNLINKED (${unlinkedHolders.length} wallets, ${fmtPct(unlinkedPct)}) ──`);
        lines.push('  │');
        const showCount = Math.min(5, unlinkedHolders.length);
        for (let i = 0; i < showCount; i++) {
          const h = unlinkedHolders[i];
          const pct = effectiveSupply > 0 ? (h.balance / effectiveSupply * 100) : 0;
          const risk = h.riskData || { level: '🟢 LOW', score: 0 };
          const riskIcon = risk.level.split(' ')[0];
          const connector = (i === showCount - 1 && unlinkedHolders.length <= 5) ? '└──' : '├──';
          lines.push(`  ${connector} ${bubbleChar(pct)} ${fmtPct(pct).padEnd(7)} ${shortAddr(h.owner)}  ${riskIcon}${risk.score}`);
        }
        if (unlinkedHolders.length > 5) {
          const restBal = unlinkedHolders.slice(5).reduce((s, h) => s + h.balance, 0);
          const restPct = effectiveSupply > 0 ? (restBal / effectiveSupply * 100) : 0;
          lines.push(`  └── ... ${unlinkedHolders.length - 5} more (${fmtPct(restPct)})`);
        }
        lines.push('');
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // SECTION 4: TOP RISK HOLDERS
    // ═══════════════════════════════════════════════════════════════════
    const highRiskHolders = sorted.filter(h => h.riskData.score >= 35);
    const lowRiskHolders = sorted.filter(h => h.riskData.score < 35);

    lines.push('═'.repeat(80));
    lines.push(`  🚨 TOP RISK HOLDERS (${highRiskHolders.length} with Score ≥ 35)`);
    lines.push('═'.repeat(80));

    for (let idx = 0; idx < highRiskHolders.length; idx++) {
      const holder = highRiskHolders[idx];
      const risk = holder.riskData;
      const percentage = effectiveSupply > 0 ? (holder.balance / effectiveSupply * 100) : 0;
      const age = holder.walletAgeDays !== null && holder.walletAgeDays !== undefined
        ? `${holder.walletAgeDays}d` : '?';
      const totalTokens = holder.historicalTokenCount || holder.tokenCount || 0;
      const heldTokens = holder.tokenCount || 0;
      const riskIcon = risk.level.split(' ')[0];

      lines.push('');
      lines.push(`  #${idx + 1}  ${riskIcon} ${risk.score}/100  ${holder.owner}`);

      // Holdings line
      let infoLine = `      ${holder.balance.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens (${fmtPct(percentage)}) | Age: ${age} | ${totalTokens} tokens (${heldTokens} held)`;
      if (holder.entryPriceSol != null && holder.entryPriceSol > 0) {
        const ep = holder.entryPriceSol;
        const epStr = ep < 0.000001 ? ep.toExponential(2) : ep.toFixed(8);
        const solStr = holder.solSpent != null ? ` (${holder.solSpent.toFixed(0)} SOL spent)` : '';
        infoLine += `\n      Entry: ${epStr} SOL/token${solStr}`;
      }
      lines.push(infoLine);

      // Compact risk factors on one line
      const compactFactors = risk.factors.map(f => {
        // Strip emoji and trim, then abbreviate
        return f.replace(/^→\s*/, '').replace(/^\s+/, '');
      });
      lines.push(`      ${compactFactors.join(' · ')}`);
    }

    // Compact table for low-risk holders
    if (lowRiskHolders.length > 0) {
      lines.push('');
      lines.push('─'.repeat(80));
      lines.push(`  OTHER (${lowRiskHolders.length} holders, Score < 35)`);
      lines.push('─'.repeat(80));
      lines.push('  Score │ Supply │  Age │ Wallet');
      lines.push('  ──────┼────────┼──────┼' + '─'.repeat(50));

      for (const holder of lowRiskHolders) {
        const pct = effectiveSupply > 0 ? (holder.balance / effectiveSupply * 100) : 0;
        const age = holder.walletAgeDays !== null && holder.walletAgeDays !== undefined
          ? `${holder.walletAgeDays}d`.padStart(4) : '   ?';
        lines.push(`  ${String(holder.riskData.score).padStart(5)} │ ${fmtPct(pct).padStart(6)} │ ${age} │ ${shortAddr(holder.owner)}`);
      }
    }

    lines.push('');
    lines.push('═'.repeat(80));
    const supplyLine = totalSupply > 0
      ? `  ${totalBalance.toLocaleString('en-US', { maximumFractionDigits: 0 })} / ${effectiveSupply.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens (${analyzedPct.toFixed(1)}%) across ${holders.length} holders`
      : `  ${totalBalance.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens across ${holders.length} holders`;
    lines.push(supplyLine);
    lines.push('═'.repeat(80));

    lines.push('');
    return lines.join('\n');
  }
}
