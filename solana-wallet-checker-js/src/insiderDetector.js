/**
 * Insider/Team Detector — Combines ALL signals to identify dev/insider groups.
 * 
 * Merges evidence from:
 * 1. Jaccard Similarity (shared token history)
 * 2. Sybil Clusters (shared funders)
 * 3. Timing Correlation (coordinated buys)
 * 4. Inter-holder SOL/Token transfers
 * 5. Token overlap patterns
 * 
 * Outputs unified "SUSPECTED INSIDER GROUPS" with confidence scoring.
 */

import { RateLimitedRPC } from './rateLimiter.js';
import { isUniversalToken, getEntityLabel, identifyExchange, isLiquidityProgram } from './knownEntities.js';

/**
 * Format a percentage for display. Handles very small values nicely.
 */
function fmtPct(pct) {
  if (pct >= 0.01) return pct.toFixed(2) + '%';
  if (pct >= 0.0001) return pct.toFixed(4) + '%';
  if (pct > 0) return '<0.0001%';
  return '0%';
}
import { TOKEN_PROGRAM_ID } from './utils.js';

export class InsiderDetector {
  constructor(rpcUrl, maxRps = 12, config = {}) {
    this.rpc = new RateLimitedRPC(rpcUrl, maxRps);
    this.interHolderTxScan = config.interHolderTxScan || 10;
    this.useEnhancedTx = config.useEnhancedTx || false;
    this.useSNS = config.useSNS || false;
  }

  /**
   * Detect inter-holder SOL transfers (holders sending SOL to each other).
   * This is a STRONG insider signal — team members distribute funds.
   * 
   * Enhanced: getTransactionsForAddress returns full txs in 1 call (paid plan).
   * Legacy: getSignaturesForAddress + N × getTransaction (N+1 calls per wallet).
   * 
   * @param {Array} holders — must have .owner
   * @returns {Promise<Array<{from, to, amountSOL, timestamp}>>}
   */
  async detectInterHolderTransfers(holders) {
    // Check inter-holder transfers
    // fast mode flag
    const holderSet = new Set(holders.map(h => h.owner));
    const transfers = [];

    for (let i = 0; i < holders.length; i++) {
      try {
        let txsToProcess = [];

        // ── Enhanced: getTransactionsForAddress (1 call per wallet) ──
        if (this.useEnhancedTx) {
          try {
            const txs = await this.rpc.call('getTransactionsForAddress', [
              holders[i].owner, { limit: this.interHolderTxScan, encoding: 'jsonParsed' },
            ]);
            if (Array.isArray(txs) && txs.length > 0) {
              txsToProcess = txs;
            }
          } catch { /* fall through to legacy */ }
        }

        // ── Legacy: getSignaturesForAddress + getTransaction ──
        if (txsToProcess.length === 0) {
          const sigs = await this.rpc.call('getSignaturesForAddress', [
            holders[i].owner, { limit: 100 },
          ]);
          if (!sigs || sigs.length === 0) continue;

          for (const sigInfo of sigs.slice(0, this.interHolderTxScan)) {
            if (!sigInfo.signature) continue;
            try {
              const tx = await this.rpc.call('getTransaction', [
                sigInfo.signature,
                { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
              ]);
              if (tx) txsToProcess.push({ ...tx, _blockTime: sigInfo.blockTime, _signature: sigInfo.signature });
            } catch { continue; }
          }
        }

        // ── Process collected transactions ──
        for (const tx of txsToProcess) {
          if (!tx?.meta) continue;

          const keys = tx.transaction?.message?.accountKeys || [];
          const pre = tx.meta.preBalances || [];
          const post = tx.meta.postBalances || [];
          const blockTime = tx.blockTime || tx._blockTime;
          const signature = tx.transaction?.signatures?.[0] || tx._signature || '';

          for (let k = 0; k < keys.length; k++) {
            const addr = typeof keys[k] === 'object' ? keys[k].pubkey?.toString() : keys[k]?.toString();
            if (!addr || addr === holders[i].owner) continue;
            if (!holderSet.has(addr)) continue;

            const diff = (post[k] || 0) - (pre[k] || 0);
            if (Math.abs(diff) > 1000) { // >0.000001 SOL
              transfers.push({
                from: diff > 0 ? holders[i].owner : addr,
                to: diff > 0 ? addr : holders[i].owner,
                amountSOL: Math.abs(diff) / 1e9,
                timestamp: blockTime ? new Date(blockTime * 1000) : null,
                signature,
                type: 'SOL',
              });
            }
          }

          // ── Also check SPL token transfers between holders ──
          const preTokenBals = tx.meta.preTokenBalances || [];
          const postTokenBals = tx.meta.postTokenBalances || [];

          // Build owner→mint→balance maps
          const preTokenMap = new Map();
          for (const bal of preTokenBals) {
            if (bal.owner && holderSet.has(bal.owner)) {
              const key = `${bal.owner}|${bal.mint}`;
              preTokenMap.set(key, parseFloat(bal.uiTokenAmount?.uiAmountString || bal.uiTokenAmount?.uiAmount || '0'));
            }
          }
          const postTokenMap = new Map();
          for (const bal of postTokenBals) {
            if (bal.owner && holderSet.has(bal.owner)) {
              const key = `${bal.owner}|${bal.mint}`;
              postTokenMap.set(key, parseFloat(bal.uiTokenAmount?.uiAmountString || bal.uiTokenAmount?.uiAmount || '0'));
            }
          }

          // Find token sends & receives between holders in same tx
          const allKeys = new Set([...preTokenMap.keys(), ...postTokenMap.keys()]);
          const senders = [];
          const receivers = [];
          for (const key of allKeys) {
            const [owner, mint] = key.split('|');
            if (owner === holders[i].owner || !holderSet.has(owner)) continue;
            const pre = preTokenMap.get(key) || 0;
            const post = postTokenMap.get(key) || 0;
            const delta = post - pre;
            if (delta < 0) senders.push({ owner, mint, amount: Math.abs(delta) });
            if (delta > 0) receivers.push({ owner, mint, amount: delta });
          }

          // Match: if holder[i] sent tokens and another holder received (or vice versa)
          const myKey = (mint) => `${holders[i].owner}|${mint}`;
          for (const recv of receivers) {
            const myPre = preTokenMap.get(myKey(recv.mint)) || 0;
            const myPost = postTokenMap.get(myKey(recv.mint)) || 0;
            if (myPre - myPost > 0) { // I sent, they received
              transfers.push({
                from: holders[i].owner,
                to: recv.owner,
                amountSOL: 0,
                tokenAmount: recv.amount,
                tokenMint: recv.mint,
                timestamp: blockTime ? new Date(blockTime * 1000) : null,
                signature,
                type: 'TOKEN',
              });
            }
          }
          for (const send of senders) {
            const myPre = preTokenMap.get(myKey(send.mint)) || 0;
            const myPost = postTokenMap.get(myKey(send.mint)) || 0;
            if (myPost - myPre > 0) { // They sent, I received
              transfers.push({
                from: send.owner,
                to: holders[i].owner,
                amountSOL: 0,
                tokenAmount: send.amount,
                tokenMint: send.mint,
                timestamp: blockTime ? new Date(blockTime * 1000) : null,
                signature,
                type: 'TOKEN',
              });
            }
          }
        }
      } catch { continue; }

      if ((i + 1) % 5 === 0 || i === holders.length - 1) {
        // transfer scan progress silent
      }
    }

    // Deduplicate by signature
    const seen = new Set();
    const unique = [];
    for (const t of transfers) {
      const key = `${t.signature}|${t.from}|${t.to}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(t);
      }
    }

    // transfer scan complete
    return unique;
  }

  // ─── SNS Domain Detection ────────────────────────────────────────────────

  /**
   * Check if holders have .sol domains (Solana Name Service).
   * Wallets with .sol domains are more likely real users, less likely sybil.
   * 
   * @param {Array} holders — must have .owner
   * @returns {Promise<Map<string, string[]>>} wallet → domain names
   */
  async detectSNSDomains(holders) {
    if (!this.useSNS) return new Map();

    // Check SNS domains
    const domainMap = new Map();

    for (const holder of holders) {
      try {
        const result = await this.rpc.call('sns_getAllDomainsForOwner', [holder.owner]);
        if (Array.isArray(result) && result.length > 0) {
          domainMap.set(holder.owner, result);
        }
      } catch { continue; }
    }

    if (domainMap.size > 0) {
      // domains found
    } else {
      // no domains
    }

    return domainMap;
  }

  /**
   * Combine ALL signals into unified Insider Groups.
   * 
   * Logic:
   * - Start with Jaccard similarity groups (strongest token overlap signal)
   * - Merge in sybil clusters (shared funders)
   * - Merge in timing clusters (coordinated buys)
   * - Add inter-holder transfer connections
   * - Calculate confidence score per group
   * 
   * @param {Array} holders
   * @param {object} similarityAnalysis — from holderAnalyzer.analyzeHolderSimilarities
   * @param {object} fundingAnalysis — from fundingAnalyzer.analyzeFundingChains
   * @param {Array} interHolderTransfers — from detectInterHolderTransfers
   * @param {Map} [snsDomains] — wallet → domain names (from detectSNSDomains)
   * @returns {Array<InsiderGroup>}
   */
  detectInsiderGroups(holders, similarityAnalysis, fundingAnalysis, interHolderTransfers = [], snsDomains = new Map(), totalSupply = 0) {
    // Build a connection graph: wallet → Set<connected wallets>
    const connections = new Map();
    const evidence = new Map(); // "walletA|walletB" → [{type, detail}]

    const addConnection = (w1, w2, type, detail) => {
      if (w1 === w2) return;
      if (!connections.has(w1)) connections.set(w1, new Set());
      if (!connections.has(w2)) connections.set(w2, new Set());
      connections.get(w1).add(w2);
      connections.get(w2).add(w1);

      const key = [w1, w2].sort().join('|');
      if (!evidence.has(key)) evidence.set(key, []);
      // Avoid duplicate evidence types
      const existing = evidence.get(key);
      if (!existing.some(e => e.type === type)) {
        existing.push({ type, detail });
      }
    };

    // Signal 1: Jaccard similarity groups
    if (similarityAnalysis?.groups) {
      for (const group of similarityAnalysis.groups) {
        for (let i = 0; i < group.wallets.length; i++) {
          for (let j = i + 1; j < group.wallets.length; j++) {
            const sharedTokens = group.commonTokens || [];
            addConnection(group.wallets[i], group.wallets[j], 'TOKEN_OVERLAP', {
              jaccard: group.avgJaccard,
              sharedTokens,
              sharedCount: group.commonTokenCount || sharedTokens.length,
            });
          }
        }
      }
    }

    // Signal 2: Sybil clusters (shared funders)
    // SKIP if funder is a known entity (exchange, bot, DEX) — those are customers, not insiders
    if (fundingAnalysis?.clusters) {
      for (const cluster of fundingAnalysis.clusters) {
        const funder = cluster.funder;
        if (funder && funder !== 'INTERNAL') {
          const isKnown = identifyExchange(funder).isExchange || isLiquidityProgram(funder);
          if (isKnown) continue; // skip — funded by exchange/bot/DEX
        }
        for (let i = 0; i < cluster.wallets.length; i++) {
          for (let j = i + 1; j < cluster.wallets.length; j++) {
            addConnection(cluster.wallets[i], cluster.wallets[j], 'SHARED_FUNDER', {
              funder: cluster.funder,
              type: cluster.type,
            });
          }
        }
      }
    }

    // Signal 3: Timing clusters
    if (similarityAnalysis?.timingClusters) {
      for (const tc of similarityAnalysis.timingClusters) {
        for (let i = 0; i < tc.wallets.length; i++) {
          for (let j = i + 1; j < tc.wallets.length; j++) {
            addConnection(tc.wallets[i], tc.wallets[j], 'TIMING', {
              spreadSeconds: tc.spreadSeconds,
            });
          }
        }
      }
    }

    // Signal 4: Inter-holder transfers (SOL + token)
    for (const transfer of interHolderTransfers) {
      const evidenceType = transfer.type === 'TOKEN' ? 'TOKEN_TRANSFER' : 'SOL_TRANSFER';
      addConnection(transfer.from, transfer.to, evidenceType, {
        amountSOL: transfer.amountSOL,
        tokenAmount: transfer.tokenAmount,
        tokenMint: transfer.tokenMint,
        timestamp: transfer.timestamp,
        type: transfer.type,
      });
    }

    // ── Group connected wallets using Union-Find ──
    const parent = new Map();
    const find = (x) => {
      if (!parent.has(x)) parent.set(x, x);
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
      return parent.get(x);
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    for (const [wallet, peers] of connections) {
      for (const peer of peers) {
        union(wallet, peer);
      }
    }

    // Collect groups
    const groupMap = new Map();
    for (const wallet of connections.keys()) {
      const root = find(wallet);
      if (!groupMap.has(root)) groupMap.set(root, new Set());
      groupMap.get(root).add(wallet);
    }

    // Build insider groups with confidence scoring
    const holderMap = new Map(holders.map(h => [h.owner, h]));
    // Use real totalSupply if provided, otherwise fall back to sum of analyzed holders
    const holderSum = holders.reduce((s, h) => s + h.balance, 0);
    const effectiveSupply = totalSupply > 0 ? totalSupply : holderSum;
    const insiderGroups = [];

    for (const [, members] of groupMap) {
      if (members.size < 2) continue;

      const walletList = [...members];
      
      // Collect all evidence for this group
      const groupEvidence = {
        tokenOverlap: false,
        sharedFunder: false,
        timing: false,
        solTransfer: false,
        tokenTransfer: false,
        avgJaccard: 0,
        sharedTokens: new Set(),
        funders: new Set(),
        transfers: [],
        timingSpread: null,
      };

      let jaccardSum = 0;
      let jaccardCount = 0;

      for (let i = 0; i < walletList.length; i++) {
        for (let j = i + 1; j < walletList.length; j++) {
          const key = [walletList[i], walletList[j]].sort().join('|');
          const evList = evidence.get(key) || [];

          for (const ev of evList) {
            switch (ev.type) {
              case 'TOKEN_OVERLAP':
                groupEvidence.tokenOverlap = true;
                jaccardSum += ev.detail.jaccard;
                jaccardCount++;
                for (const t of (ev.detail.sharedTokens || [])) groupEvidence.sharedTokens.add(t);
                break;
              case 'SHARED_FUNDER':
                groupEvidence.sharedFunder = true;
                if (ev.detail.funder) groupEvidence.funders.add(ev.detail.funder);
                break;
              case 'TIMING':
                groupEvidence.timing = true;
                groupEvidence.timingSpread = ev.detail.spreadSeconds;
                break;
              case 'SOL_TRANSFER':
                groupEvidence.solTransfer = true;
                groupEvidence.transfers.push(ev.detail);
                break;
              case 'TOKEN_TRANSFER':
                groupEvidence.tokenTransfer = true;
                groupEvidence.transfers.push(ev.detail);
                break;
            }
          }
        }
      }

      if (jaccardCount > 0) groupEvidence.avgJaccard = jaccardSum / jaccardCount;

      // ── Confidence Score (0-100) ──
      let confidence = 0;
      const signals = [];

      // Token overlap (0-35pts) — strongest insider signal
      if (groupEvidence.tokenOverlap) {
        const j = groupEvidence.avgJaccard;
        const sc = groupEvidence.sharedTokens.size;
        if (j >= 0.7) { confidence += 35; signals.push(`🔴 Token overlap sangat tinggi (J=${j.toFixed(2)}, ${sc} shared) — 35pts`); }
        else if (j >= 0.4) { confidence += 25; signals.push(`🟠 Token overlap tinggi (J=${j.toFixed(2)}, ${sc} shared) — 25pts`); }
        else if (j >= 0.15) { confidence += 15; signals.push(`🟡 Token overlap moderate (J=${j.toFixed(2)}, ${sc} shared) — 15pts`); }
        else if (j >= 0.08) { confidence += 10; signals.push(`🟡 Token overlap low-moderate (J=${j.toFixed(2)}, ${sc} shared) — 10pts`); }
        // j < 0.08 = noise, no points
      }

      // Shared funder (0-25pts)
      if (groupEvidence.sharedFunder) {
        confidence += 25;
        const funderLabels = [...groupEvidence.funders].map(f => getEntityLabel(f) || f.slice(0, 12) + '...').join(', ');
        signals.push(`💰 Didanai dari sumber yang sama (${funderLabels}) — 25pts`);
      }

      // SOL Transfer between holders (0-20pts) — very strong signal
      if (groupEvidence.solTransfer) {
        confidence += 20;
        const totalSOL = groupEvidence.transfers.filter(t => t.type !== 'TOKEN').reduce((s, t) => s + (t.amountSOL || 0), 0);
        signals.push(`🔗 Transfer SOL antar-holder (${totalSOL.toFixed(4)} SOL total) — 20pts`);
      }

      // Token Transfer between holders (0-15pts) — strong signal
      if (groupEvidence.tokenTransfer) {
        const tokenTransfers = groupEvidence.transfers.filter(t => t.type === 'TOKEN');
        confidence += 15;
        signals.push(`🪙 Transfer token antar-holder (${tokenTransfers.length} transaksi) — 15pts`);
      }

      // Coordinated timing (0-15pts)
      if (groupEvidence.timing) {
        const spread = groupEvidence.timingSpread;
        if (spread <= 60) { confidence += 15; signals.push(`⏱️  Beli dalam ${spread}s — sangat terkoordinasi — 15pts`); }
        else if (spread <= 300) { confidence += 10; signals.push(`⏱️  Beli dalam ${Math.round(spread / 60)}min — terkoordinasi — 10pts`); }
        else { confidence += 5; signals.push(`⏱️  Beli dalam waktu berdekatan — 5pts`); }
      }

      // Group size bonus (0-5pts)
      if (members.size >= 5) { confidence += 5; signals.push(`👥 Grup besar: ${members.size} wallet — 5pts`); }
      else if (members.size >= 3) { confidence += 3; signals.push(`👥 ${members.size} wallets dalam grup — 3pts`); }

      // SNS domain penalty — wallets with .sol domains are more likely real users
      // If majority in group have .sol domains, reduce confidence (-5 to -15pts)
      if (snsDomains.size > 0) {
        const domainsInGroup = walletList.filter(w => snsDomains.has(w));
        const domainRatio = domainsInGroup.length / walletList.length;
        if (domainRatio >= 0.5) {
          const penalty = domainRatio >= 0.8 ? -15 : -10;
          confidence += penalty;
          const domainNames = domainsInGroup.map(w => (snsDomains.get(w) || []).join(', ')).filter(Boolean).join('; ');
          signals.push(`🏷️  ${domainsInGroup.length}/${walletList.length} punya .sol domain (${domainNames}) — ${penalty}pts`);
        } else if (domainsInGroup.length > 0) {
          confidence -= 5;
          signals.push(`🏷️  ${domainsInGroup.length} wallet punya .sol domain — -5pts`);
        }
      }

      confidence = Math.max(0, Math.min(100, confidence));

      // Supply controlled
      const groupBalance = walletList.reduce((s, w) => {
        const h = holderMap.get(w);
        return s + (h ? h.balance : 0);
      }, 0);
      const supplyPct = effectiveSupply > 0 ? (groupBalance / effectiveSupply * 100) : 0;

      // Confidence label
      let confidenceLabel;
      if (confidence >= 70) confidenceLabel = '🔴 SANGAT MUNGKIN INSIDER/TEAM';
      else if (confidence >= 45) confidenceLabel = '🟠 KEMUNGKINAN BESAR INSIDER';
      else if (confidence >= 25) confidenceLabel = '🟡 DICURIGAI TERKAIT';
      else confidenceLabel = '⚪ KONEKSI LEMAH';

      // Filter out noise — groups with confidence < 10 are random coincidence
      if (confidence < 10) continue;

      insiderGroups.push({
        wallets: walletList,
        walletCount: members.size,
        confidence,
        confidenceLabel,
        signals,
        evidence: groupEvidence,
        supplyPct: Math.round(supplyPct * 10) / 10,
        groupBalance,
      });
    }

    // Sort by confidence descending
    insiderGroups.sort((a, b) => b.confidence - a.confidence);
    return insiderGroups;
  }

  /**
   * Format insider group output.
   * @param {Array} insiderGroups
   * @param {Array} holders
   * @param {object} fundingAnalysis
   * @returns {string}
   */
  formatInsiderOutput(insiderGroups, holders, fundingAnalysis, totalSupply = 0) {
    const lines = [];
    const totalBalance = holders.reduce((s, h) => s + h.balance, 0);
    const effectiveSupply = totalSupply > 0 ? totalSupply : totalBalance;
    const holderMap = new Map(holders.map(h => [h.owner, h]));

    /** Shorten address */
    const sh = (addr) => addr || '?';
    /** Bubble char */
    const bc = (pct) => pct >= 5 ? '⬤' : pct >= 1 ? '◉' : pct >= 0.5 ? '●' : '○';

    lines.push('');
    lines.push('╔' + '═'.repeat(78) + '╗');
    lines.push('║  🕵️  INSIDER / TEAM DETECTION                                                ║');
    lines.push('╚' + '═'.repeat(78) + '╝');

    if (insiderGroups.length === 0) {
      lines.push('');
      lines.push('  ✅ Tidak ditemukan grup insider yang mencurigakan.');
      lines.push('');
      return lines.join('\n');
    }

    // Summary
    const totalInsiderWallets = insiderGroups.reduce((s, g) => s + g.walletCount, 0);
    const totalInsiderSupply = insiderGroups.reduce((s, g) => s + g.supplyPct, 0);
    const highConfidence = insiderGroups.filter(g => g.confidence >= 45).length;

    lines.push('');
    lines.push(`  📊 ${insiderGroups.length} grup — ${totalInsiderWallets} wallets — ${fmtPct(totalInsiderSupply)} supply${highConfidence > 0 ? ` — ⚠️ ${highConfidence} high confidence` : ''}`);
    lines.push('');

    for (let gi = 0; gi < insiderGroups.length; gi++) {
      const group = insiderGroups[gi];

      lines.push('  ┌──── GRUP #' + (gi + 1) + ' ' + group.confidenceLabel + ' (' + group.confidence + '/100) ── ' + group.walletCount + ' wallets, ' + fmtPct(group.supplyPct) + ' ────');

      // Signals on one line each (compact)
      for (const signal of group.signals) {
        lines.push(`  │  ${signal}`);
      }
      lines.push('  │');

      // Members — show top 5 by balance, summarize rest
      const sortedMembers = group.wallets
        .map(w => ({ wallet: w, holder: holderMap.get(w) }))
        .filter(x => x.holder)
        .sort((a, b) => b.holder.balance - a.holder.balance);

      const showCount = Math.min(5, sortedMembers.length);
      for (let mi = 0; mi < showCount; mi++) {
        const { wallet, holder: h } = sortedMembers[mi];
        const pct = h && effectiveSupply > 0 ? (h.balance / effectiveSupply * 100) : 0;
        const age = h?.walletAgeDays != null ? `${h.walletAgeDays}d` : '?';
        const score = h?.riskData?.score ?? '?';
        lines.push(`  │  ${bc(pct)} ${fmtPct(pct).padEnd(7)} ${sh(wallet)}  Age:${age.padEnd(5)} Risk:${score}`);
      }
      if (sortedMembers.length > 5) {
        const restBal = sortedMembers.slice(5).reduce((s, x) => s + (x.holder?.balance || 0), 0);
        const restPct = effectiveSupply > 0 ? (restBal / effectiveSupply * 100) : 0;
        lines.push(`  │  ... +${sortedMembers.length - 5} wallets (${fmtPct(restPct)})`);
      }

      // Funders (compact)
      if (group.evidence.funders.size > 0) {
        const funderList = [...group.evidence.funders].map(f => {
          const label = getEntityLabel(f);
          return label ? `${sh(f)} ${label}` : sh(f);
        });
        lines.push(`  │  💰 Funder: ${funderList.join(', ')}`);
      }

      // Transfers (compact — count only)
      if (group.evidence.transfers.length > 0) {
        const solTx = group.evidence.transfers.filter(t => t.type !== 'TOKEN').length;
        const tokTx = group.evidence.transfers.filter(t => t.type === 'TOKEN').length;
        const parts = [];
        if (solTx > 0) parts.push(`${solTx} SOL`);
        if (tokTx > 0) parts.push(`${tokTx} token`);
        lines.push(`  │  🔄 ${parts.join(' + ')} transfer(s) antar-holder`);
      }

      lines.push('  └' + '─'.repeat(76));
      lines.push('');
    }

    return lines.join('\n');
  }
}
