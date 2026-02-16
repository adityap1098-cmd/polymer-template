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
      useEnhancedTx: config.useEnhancedTx || false,
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
    console.log(`  💰 Tracing funding chains (${maxHops}-hop)...`);

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
        // progress tracked silently
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
      // ── Enhanced: getTransactionsForAddress returns full txs in 1 call ──
      if (this.config.useEnhancedTx) {
        try {
          const txs = await this.rpc.call('getTransactionsForAddress', [
            wallet, { limit: 20, encoding: 'jsonParsed' },
          ]);

          if (Array.isArray(txs) && txs.length > 0) {
            // Sort by slot ascending → oldest first
            const sorted = [...txs].sort((a, b) => (a.slot || 0) - (b.slot || 0));

            for (const tx of sorted.slice(0, 3)) {
              if (!tx?.meta) continue;
              const result = this._extractFunderFromTx(tx, wallet);
              if (result) return result;
            }
            return null;
          }
        } catch { /* fall through to legacy */ }
      }

      // ── Legacy: getSignaturesForAddress + getTransaction ──
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
          const result = this._extractFunderFromTx(tx, wallet, sigInfo.blockTime);
          if (result) return result;
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
   * Extract the SOL funder from a transaction.
   * @private
   */
  _extractFunderFromTx(tx, wallet, blockTimeOverride = null) {
    const meta = tx.meta;
    if (!meta) return null;

    const preBalances = meta.preBalances || [];
    const postBalances = meta.postBalances || [];
    const accountKeys = tx.transaction?.message?.accountKeys || [];
    const blockTime = blockTimeOverride || tx.blockTime;

    const walletIndex = accountKeys.findIndex(k => {
      const addr = typeof k === 'object' ? k.pubkey?.toString() : k?.toString();
      return addr === wallet;
    });

    if (walletIndex >= 0) {
      const received = (postBalances[walletIndex] || 0) - (preBalances[walletIndex] || 0);
      if (received > 0) {
        for (let j = 0; j < preBalances.length; j++) {
          if (j === walletIndex) continue;
          const sent = (preBalances[j] || 0) - (postBalances[j] || 0);
          if (sent > 0 && j < accountKeys.length) {
            const key = accountKeys[j];
            const funderAddr = typeof key === 'object' ? key.pubkey?.toString() : key?.toString();
            if (funderAddr && funderAddr.length >= 32 && funderAddr !== '11111111111111111111111111111111') {
              return {
                funder: funderAddr,
                timestamp: blockTime ? new Date(blockTime * 1000) : null,
                amountSOL: received / 1e9,
              };
            }
          }
        }
      }
    }

    return null;
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
  formatFundingOutput(analysis, holders, totalSupply = 0) {
    const lines = [];
    const sh = (addr) => addr || '?';
    const bc = (pct) => pct >= 5 ? '⬤' : pct >= 1 ? '◉' : pct >= 0.5 ? '●' : '○';
    const fp = (n) => n >= 10 ? n.toFixed(1) + '%' : n >= 1 ? n.toFixed(2) + '%' : n.toFixed(3) + '%';
    const totalBalance = holders.reduce((s, h) => s + h.balance, 0);
    const effectiveSupply = totalSupply > 0 ? totalSupply : totalBalance;

    lines.push('');
    lines.push('╔' + '═'.repeat(78) + '╗');
    lines.push('║  💰 FUNDING CHAIN                                                            ║');
    lines.push('╚' + '═'.repeat(78) + '╝');

    // Quick summary
    let tracedCount = 0, unknownCount = 0, entityCount = 0;
    for (const holder of holders) {
      const data = analysis.fundingMap.get(holder.owner);
      if (!data || !data.funder) { unknownCount++; continue; }
      if (getEntityLabel(data.funder)) entityCount++;
      tracedCount++;
    }
    lines.push('');
    lines.push(`  Traced: ${tracedCount}/${holders.length} | Unknown: ${unknownCount} | Known entity: ${entityCount}`);
    lines.push('');

    // ── Group by ultimate funder (root of chain) ──
    const groupByRoot = new Map();
    const unknownHolders = [];

    for (const holder of holders) {
      const data = analysis.fundingMap.get(holder.owner);
      const pct = effectiveSupply > 0 ? (holder.balance / effectiveSupply * 100) : 0;

      if (!data || !data.funder) {
        unknownHolders.push({ holder, pct });
        continue;
      }

      // Find root funder (end of chain)
      let root = data.funder;
      if (data.chain && data.chain.length >= 2) {
        root = data.chain[data.chain.length - 1].from;
      } else if (data.funderOfFunder) {
        root = data.funderOfFunder;
      }

      if (!groupByRoot.has(root)) groupByRoot.set(root, []);
      groupByRoot.get(root).push({ holder, data, pct });
    }

    // Separate into known entities, multi-funded clusters, and unique wallets
    const knownGroups = [];
    const multiGroups = [];
    const uniqueWallets = [];

    for (const [root, members] of groupByRoot.entries()) {
      const label = getEntityLabel(root);
      const totalPct = members.reduce((s, m) => s + m.pct, 0);
      members.sort((a, b) => b.pct - a.pct);

      if (label) {
        knownGroups.push({ rootAddr: root, label, members, totalPct });
      } else if (members.length >= 2) {
        multiGroups.push({ rootAddr: root, label: `Shared funder`, members, totalPct });
      } else {
        uniqueWallets.push({ ...members[0], funderAddr: root });
      }
    }

    knownGroups.sort((a, b) => b.totalPct - a.totalPct);
    multiGroups.sort((a, b) => b.totalPct - a.totalPct);

    // ── FROM KNOWN ENTITIES ──
    const allGroups = [...knownGroups, ...multiGroups];
    if (allGroups.length > 0) {
      lines.push('  ── FROM KNOWN ENTITIES ' + '─'.repeat(54));
      for (const group of allGroups) {
        const tag = group.label || `Cluster (${sh(group.rootAddr)})`;
        lines.push(`  ${tag} (${sh(group.rootAddr)})  ${group.members.length} wallet${group.members.length > 1 ? 's' : ''}, ${fp(group.totalPct)}`);
        for (let mi = 0; mi < group.members.length; mi++) {
          const { holder: h, data: d, pct } = group.members[mi];
          const isLast = mi === group.members.length - 1;
          const prefix = isLast ? '└──' : '├──';
          const time = d.fundedAt ? d.fundedAt.toISOString().replace('T', ' ').split('.')[0].slice(5, 16) : '';
          const amount = d.fundingAmountSOL > 0 ? ` ${d.fundingAmountSOL.toFixed(2)} SOL` : '';
          const via = (d.chain && d.chain.length >= 2) ? ` via ${sh(d.funder)}` : '';
          lines.push(`    ${prefix} ${bc(pct)} ${fp(pct).padEnd(7)} ${sh(h.owner)}${via}${time ? `  [${time}]` : ''}${amount}`);
        }
        lines.push('');
      }
    }

    // ── SNIPERS ──
    if (analysis.sniperPatterns.length > 0) {
      lines.push('  ── 🎯 SNIPERS (funded ≤1hr before buy) ' + '─'.repeat(38));
      for (const s of analysis.sniperPatterns) {
        const h = holders.find(x => x.owner === s.wallet);
        const pct = h && effectiveSupply > 0 ? (h.balance / effectiveSupply * 100) : 0;
        const fLabel = getEntityLabel(s.funder);
        const note = fLabel?.includes('🏦') ? ' (exchange)' : '';
        lines.push(`  ${bc(pct)} ${fp(pct).padEnd(7)} ${sh(s.wallet)} ← ${sh(s.funder)}${note}  ${s.fundingAmountSOL.toFixed(2)} SOL, ${s.minutesBetween}min before buy`);
      }
      lines.push('');
    }

    // ── UNIQUE WALLETS (top 5 + summary) ──
    if (uniqueWallets.length > 0) {
      uniqueWallets.sort((a, b) => b.pct - a.pct);
      lines.push(`  ── FROM UNIQUE WALLETS (${uniqueWallets.length}) ` + '─'.repeat(Math.max(1, 48 - String(uniqueWallets.length).length)));
      const showN = Math.min(5, uniqueWallets.length);
      for (let i = 0; i < showN; i++) {
        const { holder: h, data: d, pct } = uniqueWallets[i];
        const time = d.fundedAt ? d.fundedAt.toISOString().replace('T', ' ').split('.')[0].slice(5, 16) : '';
        const amount = d.fundingAmountSOL > 0 ? ` ${d.fundingAmountSOL.toFixed(2)} SOL` : '';
        lines.push(`  ${bc(pct)} ${fp(pct).padEnd(7)} ${sh(h.owner)} ← ${sh(d.funder)}${time ? `  [${time}]` : ''}${amount}`);
      }
      if (uniqueWallets.length > 5) {
        lines.push(`  ... +${uniqueWallets.length - 5} lainnya`);
      }
      lines.push('');
    }

    // ── UNKNOWN ORIGIN (compact) ──
    if (unknownHolders.length > 0) {
      unknownHolders.sort((a, b) => b.pct - a.pct);
      lines.push(`  ── UNKNOWN ORIGIN (${unknownHolders.length} wallets) ` + '─'.repeat(Math.max(1, 44 - String(unknownHolders.length).length)));
      const chunks = unknownHolders.map(u => `${bc(u.pct)} ${fp(u.pct)} ${sh(u.holder.owner)}`);
      const showChunks = chunks.slice(0, 6);
      lines.push('  ' + showChunks.join(' | '));
      if (chunks.length > 6) lines.push(`  ... +${chunks.length - 6} lainnya`);
      lines.push('');
    }

    lines.push('═'.repeat(80));
    return lines.join('\n');
  }
}
