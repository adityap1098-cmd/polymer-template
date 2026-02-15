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

import { RateLimitedRPC } from './rateLimiter.js';
import {
  EXCHANGE_WALLETS, LIQUIDITY_PROGRAMS, UNIVERSAL_TOKENS,
  identifyExchange, isLiquidityProgram, isUniversalToken, getEntityLabel,
} from './knownEntities.js';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

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
   * @param {number} [maxRps=12] - Max requests per second (QuickNode free: 15/s)
   */
  constructor(rpcUrl, maxRps = 12) {
    this.rpcUrl = rpcUrl;
    this.rpc = new RateLimitedRPC(rpcUrl, maxRps);
  }

  // ─── Token Holders Fetch ────────────────────────────────────────────────

  /**
   * Get top token holders for a token mint.
   * @param {string} tokenMint
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getTokenHolders(tokenMint, limit = 50) {
    console.log(`Fetching token accounts for ${tokenMint}...`);

    const largest = await this.rpc.call('getTokenLargestAccounts', [tokenMint]);
    if (!largest || !largest.value || largest.value.length === 0) {
      console.log('No token accounts found for this token');
      return [];
    }

    const accounts = largest.value;
    const actualCount = accounts.length;
    console.log(`Found ${actualCount} token accounts`);

    const holders = [];
    const filteredEntities = [];  // exchanges, DEX, liquidity programs
    console.log('Processing account details...');

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

        if (!owner) continue;
        if (owner.length < 32) continue;

        // Filter: known liquidity programs / DEX
        if (isLiquidityProgram(owner)) {
          filteredEntities.push({ owner, type: 'LIQUIDITY', label: '🔄 Liquidity/DEX', balance: 0 });
          continue;
        }

        // Filter: known exchange wallets
        const exchange = identifyExchange(owner);
        if (exchange.isExchange) {
          const decimals = info.tokenAmount?.decimals || 0;
          const uiAmount = decimals > 0 ? amount / Math.pow(10, decimals) : amount;
          filteredEntities.push({ owner, type: 'EXCHANGE', label: `🏦 ${exchange.name}`, balance: uiAmount });
          continue;
        }

        const decimals = info.tokenAmount?.decimals || 0;
        const uiAmount = decimals > 0 ? amount / Math.pow(10, decimals) : amount;

        holders.push({ owner, balance: uiAmount, tokenAccount: address });

        if ((i + 1) % 5 === 0) {
          console.log(`  Processed ${i + 1}/${actualCount} accounts...`);
        }
      } catch {
        continue;
      }
    }

    if (filteredEntities.length > 0) {
      console.log(`🔍 Filtered out ${filteredEntities.length} known entities (exchanges/DEX/liquidity)`);
      for (const ent of filteredEntities) {
        console.log(`   ↳ ${ent.label}: ${ent.owner.slice(0, 16)}...`);
      }
    }

    if (holders.length === 0) return { holders: [], filteredEntities };
    console.log(`After filtering: ${holders.length} valid holders`);

    holders.sort((a, b) => b.balance - a.balance);
    const topHolders = holders.slice(0, limit);
    console.log(`Analyzing top ${topHolders.length} holders...`);

    // Get purchase time + wallet age SEQUENTIALLY
    for (let i = 0; i < topHolders.length; i++) {
      try {
        const purchaseInfo = await this._getFirstPurchaseTime(topHolders[i].owner, tokenMint);
        topHolders[i].purchaseTime = purchaseInfo?.purchaseTime || null;
        topHolders[i].purchaseTimeStr = purchaseInfo?.purchaseTime
          ? purchaseInfo.purchaseTime.toISOString().replace('T', ' ').split('.')[0]
          : 'Unknown';

        // Wallet age & activity metrics
        const walletAge = await this._getWalletAge(topHolders[i].owner);
        topHolders[i].walletAgeDays = walletAge.ageDays;
        topHolders[i].txFrequency = walletAge.txPerDay;
        topHolders[i].totalTxCount = walletAge.totalTx;
      } catch {
        topHolders[i].purchaseTime = null;
        topHolders[i].purchaseTimeStr = 'Unknown';
        topHolders[i].walletAgeDays = null;
        topHolders[i].txFrequency = 0;
        topHolders[i].totalTxCount = 0;
      }
      if (!('tokenCount' in topHolders[i])) topHolders[i].tokenCount = 0;
      if ((i + 1) % 3 === 0 || i === topHolders.length - 1) {
        console.log(`  Holder info: ${i + 1}/${topHolders.length} analyzed`);
      }
    }

    const stats = this.rpc.getStats();
    console.log(`✅ Done! (${stats.totalRequests} RPC calls, ${stats.totalErrors} rate limits hit)`);
    return { holders: topHolders, filteredEntities };
  }

  // ─── Wallet Age Analysis ────────────────────────────────────────────────

  /**
   * Get wallet age in days and activity frequency.
   * Modern tools use this to filter fresh snipers vs organic holders.
   */
  async _getWalletAge(wallet) {
    try {
      const sigs = await this.rpc.call('getSignaturesForAddress', [wallet, { limit: 50 }]);
      if (!sigs || sigs.length === 0) return { ageDays: 0, txPerDay: 0, totalTx: 0 };

      const totalTx = sigs.length;

      // Sort ascending by slot
      sigs.sort((a, b) => (a.slot || 0) - (b.slot || 0));
      const oldest = sigs[0]?.blockTime;
      const newest = sigs[sigs.length - 1]?.blockTime;

      if (!oldest) return { ageDays: 0, txPerDay: 0, totalTx };

      const nowSec = Date.now() / 1000;
      const ageDays = Math.max(1, (nowSec - oldest) / 86400);

      const activeDays = newest && oldest !== newest
        ? Math.max(1, (newest - oldest) / 86400)
        : 1;
      const txPerDay = totalTx / activeDays;

      return { ageDays: Math.round(ageDays), txPerDay: Math.round(txPerDay * 100) / 100, totalTx };
    } catch {
      return { ageDays: null, txPerDay: 0, totalTx: 0 };
    }
  }

  // ─── Token Trading History ──────────────────────────────────────────────

  /**
   * Get list of tokens traded by a wallet.
   */
  async _getWalletTokenHistory(wallet, excludeToken = null, limit = 20) {
    const tokens = new Set();

    try {
      const signatures = await this.rpc.call('getSignaturesForAddress', [wallet, { limit }]);
      if (!signatures || !Array.isArray(signatures)) return tokens;

      for (const sigInfo of signatures.slice(0, limit)) {
        const signature = sigInfo.signature;
        if (!signature) continue;

        try {
          const tx = await this.rpc.call('getTransaction', [
            signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
          ]);
          if (!tx || !tx.meta) continue;

          const allBalances = [
            ...(tx.meta.preTokenBalances || []),
            ...(tx.meta.postTokenBalances || []),
          ];
          for (const balance of allBalances) {
            if (balance.mint && balance.owner === wallet && balance.mint !== excludeToken) {
              if (!isUniversalToken(balance.mint)) {
                tokens.add(balance.mint);
              }
            }
          }

          for (const innerGroup of (tx.meta.innerInstructions || [])) {
            for (const inst of (innerGroup.instructions || [])) {
              const programId = inst.programId?.toString?.() || inst.programId;
              if (programId === TOKEN_PROGRAM_ID || programId === TOKEN_2022_PROGRAM_ID) {
                const mint = inst.parsed?.info?.mint;
                if (mint && mint !== excludeToken && !isUniversalToken(mint)) tokens.add(mint);
              }
            }
          }
        } catch { continue; }
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
    console.log(`\n🔍 Analyzing trading patterns for ${holders.length} holders (Jaccard method)...`);
    console.log('Processing sequentially to respect rate limits...\n');

    // Collect token history
    for (let i = 0; i < holders.length; i++) {
      try {
        const tokens = await this._getWalletTokenHistory(holders[i].owner, currentToken);
        holders[i].tradedTokens = tokens;
        holders[i].tokenCount = tokens.size;
      } catch {
        holders[i].tradedTokens = new Set();
        holders[i].tokenCount = 0;
      }
      console.log(`   [${i + 1}/${holders.length}] ${holders[i].owner.slice(0, 12)}... → ${holders[i].tokenCount} tokens`);
    }

    console.log('✅ Trading history complete!\n');

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

        // Jaccard ≥ 0.15 is considered notable (calibrated threshold)
        if (jaccard >= 0.15 && commonTokens.size >= 2) {
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
  calculateRiskScore(holder, allHolders, similarityAnalysis = null, fundingAnalysis = null) {
    let riskScore = 0;
    const riskFactors = [];
    const wallet = holder.owner;
    const balance = holder.balance;
    const tokenCount = holder.tokenCount || 0;

    const totalSupply = allHolders.reduce((sum, h) => sum + h.balance, 0);
    const holderPercentage = totalSupply > 0 ? (balance / totalSupply * 100) : 0;

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
  calculateTokenHealth(holders, similarityAnalysis = null, fundingAnalysis = null) {
    const balances = holders.map(h => h.balance);
    const totalBalance = balances.reduce((s, v) => s + v, 0);

    // Gini coefficient
    const gini = calculateGini(balances);

    // Top holder concentration
    const sorted = [...balances].sort((a, b) => b - a);
    const top5Pct = totalBalance > 0 ? (sorted.slice(0, 5).reduce((s, v) => s + v, 0) / totalBalance * 100) : 0;
    const top10Pct = totalBalance > 0 ? (sorted.slice(0, 10).reduce((s, v) => s + v, 0) / totalBalance * 100) : 0;

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
      const signatures = await this.rpc.call('getSignaturesForAddress', [wallet, { limit: 50 }]);
      if (!signatures || !Array.isArray(signatures) || signatures.length === 0) return null;

      signatures.sort((a, b) => (a.slot || 0) - (b.slot || 0));

      for (const sigInfo of signatures.slice(0, 10)) {
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
              return { purchaseTime: blockTime ? new Date(blockTime * 1000) : new Date() };
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
  formatHoldersOutput(holders, tokenMint, similarityAnalysis = null, fundingAnalysis = null, filteredEntities = []) {
    const lines = [];

    // Compute risk scores
    for (const holder of holders) {
      holder.riskData = this.calculateRiskScore(holder, holders, similarityAnalysis, fundingAnalysis);
    }

    // Token Health Overview
    const health = this.calculateTokenHealth(holders, similarityAnalysis, fundingAnalysis);

    lines.push('');
    lines.push('╔' + '═'.repeat(78) + '╗');
    lines.push('║  TOKEN HOLDER RISK ANALYSIS — ENHANCED                                      ║');
    lines.push('║  Jaccard Similarity · Gini Index · Timing Correlation · Funding Chain        ║');
    lines.push('╚' + '═'.repeat(78) + '╝');
    lines.push(`  Token: ${tokenMint}`);
    lines.push(`  Holders Analyzed: ${holders.length}`);
    lines.push('');

    // ── FILTERED ENTITIES ──
    if (filteredEntities && filteredEntities.length > 0) {
      lines.push('┌' + '─'.repeat(78) + '┐');
      lines.push('│  🔍 FILTERED ENTITIES (excluded from analysis)                               │');
      lines.push('├' + '─'.repeat(78) + '┤');

      const exchanges = filteredEntities.filter(e => e.type === 'EXCHANGE');
      const dexes = filteredEntities.filter(e => e.type === 'LIQUIDITY');

      if (exchanges.length > 0) {
        lines.push('│  🏦 EXCHANGE WALLETS:');
        for (const ex of exchanges) {
          const balStr = ex.balance > 0 ? ` (${ex.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })} tokens)` : '';
          lines.push(`│    • ${ex.label}: ${ex.owner.slice(0, 20)}...${ex.owner.slice(-8)}${balStr}`);
        }
      }
      if (dexes.length > 0) {
        lines.push('│  🔄 DEX / LIQUIDITY PROGRAMS:');
        for (const dx of dexes) {
          lines.push(`│    • ${dx.label}: ${dx.owner.slice(0, 20)}...${dx.owner.slice(-8)}`);
        }
      }
      lines.push(`│  Total Filtered: ${filteredEntities.length} entity(ies)`);
      lines.push('└' + '─'.repeat(78) + '┘');
      lines.push('');
    }

    // ── TOKEN HEALTH OVERVIEW ──
    lines.push('┌' + '─'.repeat(78) + '┐');
    lines.push('│  📊 TOKEN HEALTH OVERVIEW                                                    │');
    lines.push('├' + '─'.repeat(78) + '┤');
    lines.push(`│  Overall Risk:          ${health.tokenRiskLevel} (Score: ${health.tokenRiskScore}/100)`);
    lines.push(`│  Gini Coefficient:      ${health.gini} ${health.gini >= 0.7 ? '⚠️  (highly concentrated)' : health.gini >= 0.4 ? '(moderate concentration)' : '(well distributed)'}`);
    lines.push(`│  Top 5 Concentration:   ${health.top5Concentration}%`);
    lines.push(`│  Top 10 Concentration:  ${health.top10Concentration}%`);
    lines.push(`│  Avg Wallet Age:        ${health.avgWalletAge !== null ? health.avgWalletAge + ' days' : 'Unknown'}`);
    lines.push(`│  Fresh Wallets (≤7d):   ${health.freshWallets}/${holders.length} (${(health.freshWallets / Math.max(1, holders.length) * 100).toFixed(0)}%)`);
    lines.push(`│  Timing Clusters:       ${health.timingClusterCount} cluster(s), ${health.walletsInTimingClusters} wallets`);
    lines.push(`│  Sybil Clusters:        ${health.sybilClusterCount} cluster(s), ${health.walletsInSybil} wallets`);
    lines.push('└' + '─'.repeat(78) + '┘');
    lines.push('');

    // ── RISK SUMMARY ──
    const riskSummary = { '🔴 CRITICAL': 0, '🟠 HIGH': 0, '🟡 MEDIUM': 0, '🟢 LOW': 0 };
    for (const holder of holders) riskSummary[holder.riskData.level]++;

    lines.push('📊 HOLDER RISK DISTRIBUTION:');
    lines.push(`   🔴 Critical: ${riskSummary['🔴 CRITICAL']}  🟠 High: ${riskSummary['🟠 HIGH']}  🟡 Medium: ${riskSummary['🟡 MEDIUM']}  🟢 Low: ${riskSummary['🟢 LOW']}`);
    lines.push('');
    lines.push('═'.repeat(80));
    lines.push('');

    // ── INDIVIDUAL HOLDERS (sorted by risk) ──
    const sorted = [...holders].sort((a, b) => b.riskData.score - a.riskData.score);
    const totalBalance = holders.reduce((sum, h) => sum + h.balance, 0);

    for (let idx = 0; idx < sorted.length; idx++) {
      const holder = sorted[idx];
      const risk = holder.riskData;
      const percentage = totalBalance > 0 ? (holder.balance / totalBalance * 100) : 0;
      const age = holder.walletAgeDays !== null && holder.walletAgeDays !== undefined
        ? `${holder.walletAgeDays}d`
        : '?';
      const freq = holder.txFrequency ? `${holder.txFrequency} tx/day` : '?';

      lines.push(`#${String(idx + 1).padStart(2)} ${risk.level} (Score: ${risk.score}/100) ${'─'.repeat(20)}`);
      lines.push(`    ${risk.description}`);
      lines.push(`    Wallet:         ${holder.owner}`);
      lines.push(`    Balance:        ${holder.balance.toLocaleString('en-US', { minimumFractionDigits: 6 })} tokens (${percentage.toFixed(2)}%)`);
      lines.push(`    First Purchase: ${holder.purchaseTimeStr || 'Unknown'}`);
      const tokenNote = (holder.tokenCount || 0) === 0 && holder.tradedTokens ? ' (excl. universal)' : '';
      lines.push(`    Wallet Age:     ${age} | Activity: ${freq} | Tokens Traded: ${holder.tokenCount || 0}${tokenNote}`);

      if (risk.factors.length > 0) {
        lines.push('    Risk Factors:');
        for (const factor of risk.factors) lines.push(`       • ${factor}`);
      }
      lines.push('');
    }

    lines.push('═'.repeat(80));
    lines.push(`Total Balance (Top ${holders.length}): ${totalBalance.toLocaleString('en-US', { minimumFractionDigits: 6 })} tokens`);
    lines.push('═'.repeat(80));

    // ── SIMILARITY GROUPS ──
    if (similarityAnalysis && similarityAnalysis.groups && similarityAnalysis.groups.length > 0) {
      lines.push('');
      lines.push('🔍 TRADING PATTERN SIMILARITY (Jaccard)');
      lines.push('═'.repeat(80));
      lines.push(`Found ${similarityAnalysis.totalGroups} group(s)\n`);

      for (let gi = 0; gi < similarityAnalysis.groups.length; gi++) {
        const group = similarityAnalysis.groups[gi];
        lines.push(`  📊 Group #${gi + 1} — ${group.walletCount} wallets — Avg Jaccard: ${group.avgJaccard}`);
        lines.push('  ' + '─'.repeat(70));
        for (const wallet of group.wallets) {
          const hi = holders.find(h => h.owner === wallet);
          const bal = hi ? hi.balance.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '?';
          lines.push(`    • ${wallet}  (${bal} tokens)`);
        }
        if (group.commonTokens && group.commonTokens.length > 0) {
          lines.push(`  Common tokens (${group.commonTokenCount}):`);
          for (const token of group.commonTokens.slice(0, 5)) {
            lines.push(`    · ${token}`);
          }
        }
        lines.push('');
      }
    }

    // ── TIMING CLUSTERS ──
    if (similarityAnalysis && similarityAnalysis.timingClusters && similarityAnalysis.timingClusters.length > 0) {
      lines.push('');
      lines.push('⏱️  BUY-TIMING CORRELATION');
      lines.push('═'.repeat(80));

      for (let ti = 0; ti < similarityAnalysis.timingClusters.length; ti++) {
        const tc = similarityAnalysis.timingClusters[ti];
        const spreadStr = tc.spreadSeconds < 60
          ? `${tc.spreadSeconds} seconds`
          : `${Math.round(tc.spreadSeconds / 60)} minutes`;
        lines.push(`\n  ⏱️  Cluster #${ti + 1} — ${tc.count} wallets bought within ${spreadStr}`);
        lines.push(`  Time range: ${tc.earliest.toISOString().replace('T', ' ').split('.')[0]} → ${tc.latest.toISOString().replace('T', ' ').split('.')[0]}`);
        for (const wallet of tc.wallets) {
          lines.push(`    • ${wallet}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
