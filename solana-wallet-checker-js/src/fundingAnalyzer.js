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
   * @param {object} [config] - Plan configuration
   */
  constructor(rpcUrl, config = {}) {
    this.config = {
      maxRps: config.maxRps || 12,
      fundingHops: config.fundingHops || 2,
    };
    this.rpc = new RateLimitedRPC(rpcUrl, this.config.maxRps);
  }

  /**
   * Analyze funding origins for a list of holder wallets.
   * Traces the initial SOL funder for each wallet (configurable hops: 2 or 4).
   * 
   * @param {Array<{owner: string}>} holders
   * @returns {Promise<FundingAnalysisResult>}
   */
  async analyzeFundingChains(holders) {
    const maxHops = this.config.fundingHops;
    console.log(`\n💰 Analyzing funding chains for ${holders.length} wallets (${maxHops}-hop)...`);

    const fundingMap = new Map(); // wallet → { funder, chain: [...], fundedAt, fundingAmount }

    for (let i = 0; i < holders.length; i++) {
      const wallet = holders[i].owner;

      try {
        // Trace up to maxHops hops
        const chain = [];
        let currentAddr = wallet;
        let firstFunder = null;
        let firstTimestamp = null;
        let firstAmount = 0;

        for (let hop = 0; hop < maxHops; hop++) {
          const hopResult = await this._findInitialFunder(currentAddr);
          if (!hopResult?.funder) break;

          if (hop === 0) {
            firstFunder = hopResult.funder;
            firstTimestamp = hopResult.timestamp;
            firstAmount = hopResult.amountSOL;
          }

          chain.push({
            hop: hop + 1,
            from: hopResult.funder,
            amountSOL: hopResult.amountSOL,
            timestamp: hopResult.timestamp,
          });

          // Stop if we hit a known entity (exchange/program)
          if (this._isKnownEntity(hopResult.funder)) break;
          currentAddr = hopResult.funder;
        }

        const entry = {
          wallet,
          funder: firstFunder,
          fundedAt: firstTimestamp,
          fundingAmountSOL: firstAmount,
          funderOfFunder: chain.length >= 2 ? chain[1].from : null,
          chain,
          deepestFunder: chain.length > 0 ? chain[chain.length - 1].from : null,
        };

        fundingMap.set(wallet, entry);
      } catch {
        fundingMap.set(wallet, { wallet, funder: null, fundedAt: null, fundingAmountSOL: 0, funderOfFunder: null, chain: [], deepestFunder: null });
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
   * Group wallets by shared funder (any hop level).
   * @param {Map} fundingMap
   * @returns {Array<FundingCluster>}
   */
  _detectFundingClusters(fundingMap) {
    // Group by ALL funders in chain
    const funderGroups = new Map();

    for (const [wallet, data] of fundingMap) {
      if (!data.funder) continue;

      // Direct funder grouping
      if (!funderGroups.has(data.funder)) {
        funderGroups.set(data.funder, new Set());
      }
      funderGroups.get(data.funder).add(wallet);

      // All hops in the chain
      if (data.chain) {
        for (const hop of data.chain) {
          if (hop.from && hop.from !== data.funder) {
            if (!funderGroups.has(hop.from)) {
              funderGroups.set(hop.from, new Set());
            }
            funderGroups.get(hop.from).add(wallet);
          }
        }
      } else if (data.funderOfFunder) {
        // Legacy 2-hop fallback
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
    lines.push('╔' + '═'.repeat(78) + '╗');
    lines.push('║  💰 FUNDING CHAIN ANALYSIS                                                   ║');
    lines.push('╚' + '═'.repeat(78) + '╝');

    // ── Quick summary of known vs unknown funders ──
    let knownCount = 0;
    let unknownCount = 0;
    let entityFunded = 0;

    for (const holder of holders) {
      const data = analysis.fundingMap.get(holder.owner);
      if (!data || !data.funder) { unknownCount++; continue; }
      const label = getEntityLabel(data.funder);
      if (label) entityFunded++;
      knownCount++;
    }

    lines.push(`  Traced: ${knownCount}/${holders.length} | Unknown origin: ${unknownCount} | From known entity: ${entityFunded}`);
    lines.push('');

    // ── Funding table (compact) ──
    lines.push('  FUNDING ORIGINS:');
    lines.push('  ' + '─'.repeat(75));

    for (const holder of holders) {
      const data = analysis.fundingMap.get(holder.owner);
      if (!data) continue;

      const wallet = holder.owner;
      if (!data.funder) {
        lines.push(`  ${wallet}`);
        lines.push(`    ← Unknown`);
        continue;
      }

      const funderLabel = getEntityLabel(data.funder);
      const labelStr = funderLabel ? ` ${funderLabel}` : '';
      const amount = data.fundingAmountSOL > 0 ? `${data.fundingAmountSOL.toFixed(4)} SOL` : '';
      const time = data.fundedAt
        ? data.fundedAt.toISOString().replace('T', ' ').split('.')[0].slice(5)
        : '';
      const timeAmount = [time, amount].filter(Boolean).join(' | ');

      lines.push(`  ${wallet}`);
      let funderLine = `    ← ${data.funder}${labelStr}`;
      if (timeAmount) funderLine += `  [${timeAmount}]`;

      // Show full chain (all hops)
      if (data.chain && data.chain.length >= 2) {
        for (let h = 1; h < data.chain.length; h++) {
          const hopData = data.chain[h];
          const hopLabel = getEntityLabel(hopData.from);
          const hopStr = hopLabel ? ` ${hopLabel}` : '';
          funderLine += `\n      ${'  '.repeat(h)}← ${hopData.from}${hopStr}`;
        }
      } else if (data.funderOfFunder) {
        // Legacy 2-hop fallback
        const hop2Label = getEntityLabel(data.funderOfFunder);
        const hop2Str = hop2Label ? ` ${hop2Label}` : '';
        funderLine += `\n      ← ${data.funderOfFunder}${hop2Str}`;
      }
      lines.push(funderLine);
    }

    // Sybil clusters — skip here, already shown in main output
    // Just show sniper patterns
    if (analysis.sniperPatterns.length > 0) {
      lines.push('');
      lines.push('  🎯 SNIPER PATTERNS (funded ≤1hr before buy):');
      lines.push('  ' + '─'.repeat(75));
      for (const s of analysis.sniperPatterns) {
        const sniperFunderLabel = getEntityLabel(s.funder);
        const funderNote = sniperFunderLabel ? ` ${sniperFunderLabel}` : '';
        lines.push(`  ${s.wallet}`);
        lines.push(`    funded ${s.minutesBetween}min before buy — ${s.fundingAmountSOL.toFixed(4)} SOL from ${s.funder}${funderNote}`);
        if (sniperFunderLabel && sniperFunderLabel.includes('🏦')) {
          lines.push(`    ℹ️  Exchange withdrawal — likely normal behavior`);
        }
      }
    }

    lines.push('\n' + '='.repeat(80));
    return lines.join('\n');
  }
}
