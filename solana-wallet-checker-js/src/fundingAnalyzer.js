/**
 * Funding Chain Analyzer — Modern Sybil/Cluster Detection.
 * 
 * Tracks the funding origin of each wallet to detect:
 * - Wallets funded from the same source (sybil clusters)
 * - Fresh wallets funded just before token purchase (sniper pattern)
 * - Multi-hop funding chains (A → B → C all buying same token)
 * 
 * Used by tools like Bubblemaps, Arkham Intelligence, GMGN.
 */

import { RateLimitedRPC } from './rateLimiter.js';
import { isLiquidityProgram, identifyExchange, getEntityLabel } from './knownEntities.js';

export class FundingAnalyzer {
  /**
   * @param {string} rpcUrl
   * @param {number} [maxRps=12]
   */
  constructor(rpcUrl, maxRps = 12) {
    this.rpc = new RateLimitedRPC(rpcUrl, maxRps);
  }

  /**
   * Analyze funding origins for a list of holder wallets.
   * Traces the initial SOL funder for each wallet (up to 2 hops).
   * 
   * @param {Array<{owner: string}>} holders
   * @returns {Promise<FundingAnalysisResult>}
   */
  async analyzeFundingChains(holders) {
    console.log(`\n💰 Analyzing funding chains for ${holders.length} wallets...`);

    const fundingMap = new Map(); // wallet → { funder, funderOfFunder, fundedAt, fundingAmount }

    for (let i = 0; i < holders.length; i++) {
      const wallet = holders[i].owner;

      try {
        // Hop 1: Find who first funded this wallet with SOL
        const hop1 = await this._findInitialFunder(wallet);
        const entry = {
          wallet,
          funder: hop1?.funder || null,
          fundedAt: hop1?.timestamp || null,
          fundingAmountSOL: hop1?.amountSOL || 0,
          funderOfFunder: null,
        };

        // Hop 2: Find who funded the funder (if funder is not a known exchange/program)
        if (hop1?.funder && !this._isKnownEntity(hop1.funder)) {
          try {
            const hop2 = await this._findInitialFunder(hop1.funder);
            entry.funderOfFunder = hop2?.funder || null;
          } catch {
            // Ignore hop2 errors
          }
        }

        fundingMap.set(wallet, entry);
      } catch {
        fundingMap.set(wallet, { wallet, funder: null, fundedAt: null, fundingAmountSOL: 0, funderOfFunder: null });
      }

      if ((i + 1) % 3 === 0 || i === holders.length - 1) {
        console.log(`   Funding chain: ${i + 1}/${holders.length} analyzed`);
      }
    }

    // Detect sybil clusters — wallets sharing same funder
    const clusters = this._detectFundingClusters(fundingMap);

    // Detect sniper patterns — wallets funded very recently before purchase
    const sniperPatterns = this._detectSniperFunding(fundingMap, holders);

    const stats = this.rpc.getStats();
    console.log(`✅ Funding analysis done! (${stats.totalRequests} RPC calls, ${clusters.length} clusters found)`);

    return {
      fundingMap,
      clusters,
      sniperPatterns,
      totalClusters: clusters.length,
      totalSnipers: sniperPatterns.length,
    };
  }

  /**
   * Find the initial SOL funder of a wallet by looking at oldest transactions.
   * @param {string} wallet
   * @returns {Promise<{funder: string, timestamp: Date, amountSOL: number}|null>}
   */
  async _findInitialFunder(wallet) {
    try {
      const signatures = await this.rpc.call('getSignaturesForAddress', [
        wallet, { limit: 20 },
      ]);

      if (!signatures || !Array.isArray(signatures) || signatures.length === 0) return null;

      // Sort by slot ascending → oldest first
      signatures.sort((a, b) => (a.slot || 0) - (b.slot || 0));

      // Check the first 3 oldest transactions to find SOL transfer in
      for (const sigInfo of signatures.slice(0, 3)) {
        if (!sigInfo.signature) continue;

        try {
          const tx = await this.rpc.call('getTransaction', [
            sigInfo.signature,
            { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
          ]);

          if (!tx || !tx.meta) continue;

          const meta = tx.meta;
          const preBalances = meta.preBalances || [];
          const postBalances = meta.postBalances || [];
          const accountKeys = tx.transaction?.message?.accountKeys || [];

          // Find which account sent SOL to our wallet
          const walletIndex = accountKeys.findIndex(k => {
            const addr = typeof k === 'object' ? k.pubkey?.toString() : k?.toString();
            return addr === wallet;
          });

          if (walletIndex >= 0) {
            const received = (postBalances[walletIndex] || 0) - (preBalances[walletIndex] || 0);
            if (received > 0) {
              // Find the sender (account whose balance decreased)
              for (let j = 0; j < preBalances.length; j++) {
                if (j === walletIndex) continue;
                const sent = (preBalances[j] || 0) - (postBalances[j] || 0);
                if (sent > 0 && j < accountKeys.length) {
                  const key = accountKeys[j];
                  const funderAddr = typeof key === 'object' ? key.pubkey?.toString() : key?.toString();
                  if (funderAddr && funderAddr.length >= 32 && funderAddr !== '11111111111111111111111111111111') {
                    return {
                      funder: funderAddr,
                      timestamp: sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000) : null,
                      amountSOL: received / 1e9,
                    };
                  }
                }
              }
            }
          }
        } catch {
          continue;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Group wallets by shared funder (direct or 2-hop).
   * @param {Map} fundingMap
   * @returns {Array<FundingCluster>}
   */
  _detectFundingClusters(fundingMap) {
    // Group by direct funder
    const funderGroups = new Map();

    for (const [wallet, data] of fundingMap) {
      if (!data.funder) continue;

      // Direct funder grouping
      if (!funderGroups.has(data.funder)) {
        funderGroups.set(data.funder, new Set());
      }
      funderGroups.get(data.funder).add(wallet);

      // Also group by funder-of-funder (2-hop)
      if (data.funderOfFunder) {
        if (!funderGroups.has(data.funderOfFunder)) {
          funderGroups.set(data.funderOfFunder, new Set());
        }
        funderGroups.get(data.funderOfFunder).add(wallet);
      }
    }

    // Only keep groups with 2+ wallets
    const clusters = [];
    for (const [funder, wallets] of funderGroups) {
      if (wallets.size >= 2) {
        clusters.push({
          funder,
          wallets: [...wallets],
          walletCount: wallets.size,
          type: 'SHARED_FUNDER',
        });
      }
    }

    // Also check if any holders directly funded other holders
    const holderSet = new Set([...fundingMap.keys()]);
    const directFunding = [];
    for (const [wallet, data] of fundingMap) {
      if (data.funder && holderSet.has(data.funder)) {
        directFunding.push({
          from: data.funder,
          to: wallet,
          amountSOL: data.fundingAmountSOL,
          type: 'HOLDER_FUNDED_HOLDER',
        });
      }
    }

    if (directFunding.length > 0) {
      // Group direct funding into a cluster
      const directWallets = new Set();
      for (const df of directFunding) {
        directWallets.add(df.from);
        directWallets.add(df.to);
      }
      clusters.push({
        funder: 'INTERNAL',
        wallets: [...directWallets],
        walletCount: directWallets.size,
        type: 'INTER_HOLDER_FUNDING',
        transfers: directFunding,
      });
    }

    clusters.sort((a, b) => b.walletCount - a.walletCount);
    return clusters;
  }

  /**
   * Detect sniper patterns: wallets funded shortly before token purchase.
   * @param {Map} fundingMap
   * @param {Array} holders
   * @returns {Array}
   */
  _detectSniperFunding(fundingMap, holders) {
    const snipers = [];

    for (const holder of holders) {
      const funding = fundingMap.get(holder.owner);
      if (!funding || !funding.fundedAt || !holder.purchaseTime) continue;

      const fundedAt = funding.fundedAt.getTime();
      const purchasedAt = holder.purchaseTime.getTime();

      // If funded within 1 hour before purchase → sniper pattern
      const diffMinutes = (purchasedAt - fundedAt) / (1000 * 60);

      if (diffMinutes >= 0 && diffMinutes <= 60) {
        snipers.push({
          wallet: holder.owner,
          fundedAt: funding.fundedAt,
          purchaseTime: holder.purchaseTime,
          minutesBetween: Math.round(diffMinutes),
          fundingAmountSOL: funding.fundingAmountSOL,
          funder: funding.funder,
        });
      }
    }

    return snipers;
  }

  /**
   * Check if an address is a known exchange/program (skip hop-2 for these).
   */
  _isKnownEntity(address) {
    return isLiquidityProgram(address) || identifyExchange(address).isExchange;
  }

  /**
   * Format funding analysis for display.
   * @param {object} analysis - Result from analyzeFundingChains()
   * @param {Array} holders
   * @returns {string}
   */
  formatFundingOutput(analysis, holders) {
    const lines = [];
    lines.push('');
    lines.push('💰 ' + '='.repeat(77));
    lines.push('FUNDING CHAIN ANALYSIS (Sybil Detection)');
    lines.push('='.repeat(80));
    lines.push('');

    // Funding overview per holder
    lines.push('📋 WALLET FUNDING ORIGINS:');
    lines.push('─'.repeat(80));

    for (const holder of holders) {
      const data = analysis.fundingMap.get(holder.owner);
      if (!data) continue;

      const wallet = holder.owner;
      const funderLabel = data.funder ? (getEntityLabel(data.funder) || '') : '';
      const funder = data.funder || 'Unknown';
      const hop2Label = data.funderOfFunder ? (getEntityLabel(data.funderOfFunder) || '') : '';
      const hop2 = data.funderOfFunder ? `← ${data.funderOfFunder} ${hop2Label}` : '';
      const amount = data.fundingAmountSOL > 0 ? ` (${data.fundingAmountSOL.toFixed(4)} SOL)` : '';
      const time = data.fundedAt ? data.fundedAt.toISOString().replace('T', ' ').split('.')[0] : '?';

      lines.push(`  ${wallet}`);
      lines.push(`    ← ${funder} ${funderLabel}${amount} [${time}] ${hop2}`);
    }

    // Sybil clusters
    if (analysis.clusters.length > 0) {
      lines.push('');
      lines.push('🚨 SYBIL CLUSTERS DETECTED:');
      lines.push('─'.repeat(80));

      for (let i = 0; i < analysis.clusters.length; i++) {
        const cluster = analysis.clusters[i];
        const funderEntityLabel = cluster.funder ? (getEntityLabel(cluster.funder) || '') : '';
        const typeLabel = cluster.type === 'INTER_HOLDER_FUNDING'
          ? '⚠️  HOLDERS FUNDING EACH OTHER'
          : `🔗 Shared Funder: ${cluster.funder} ${funderEntityLabel}`;

        lines.push(`\n  Cluster #${i + 1} — ${cluster.walletCount} wallets — ${typeLabel}`);

        for (const wallet of cluster.wallets) {
          const holderInfo = holders.find(h => h.owner === wallet);
          const bal = holderInfo ? holderInfo.balance.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '?';
          lines.push(`    • ${wallet}  (${bal} tokens)`);
        }

        if (cluster.transfers) {
          lines.push('  Direct transfers:');
          for (const t of cluster.transfers) {
            lines.push(`    ${t.from} → ${t.to} (${t.amountSOL.toFixed(4)} SOL)`);
          }
        }
      }
    } else {
      lines.push('\n  ✅ No sybil clusters detected (no shared funding sources)');
    }

    // Sniper patterns
    if (analysis.sniperPatterns.length > 0) {
      lines.push('');
      lines.push('🎯 SNIPER PATTERNS (funded ≤ 1hr before purchase):');
      lines.push('─'.repeat(80));
      for (const s of analysis.sniperPatterns) {
        const sniperFunderLabel = getEntityLabel(s.funder);
        const funderNote = sniperFunderLabel ? ` ${sniperFunderLabel}` : '';
        lines.push(`  ⚡ ${s.wallet}`);
        lines.push(`    funded ${s.minutesBetween}min before buy (${s.fundingAmountSOL.toFixed(4)} SOL from ${s.funder}${funderNote})`);
        if (sniperFunderLabel && sniperFunderLabel.includes('🏦')) {
          lines.push(`    ℹ️  Note: Funded by exchange — this is normal withdrawal behavior, not necessarily sniping`);
        }
      }
    }

    lines.push('\n' + '='.repeat(80));
    return lines.join('\n');
  }
}
