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
import { isUniversalToken, getEntityLabel } from './knownEntities.js';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export class InsiderDetector {
  constructor(rpcUrl, maxRps = 12) {
    this.rpc = new RateLimitedRPC(rpcUrl, maxRps);
  }

  /**
   * Detect inter-holder SOL transfers (holders sending SOL to each other).
   * This is a STRONG insider signal — team members distribute funds.
   * 
   * @param {Array} holders — must have .owner
   * @returns {Promise<Array<{from, to, amountSOL, timestamp}>>}
   */
  async detectInterHolderTransfers(holders) {
    console.log(`\n🔗 Checking inter-holder SOL transfers (${holders.length} wallets)...`);
    const holderSet = new Set(holders.map(h => h.owner));
    const transfers = [];

    for (let i = 0; i < holders.length; i++) {
      try {
        const sigs = await this.rpc.call('getSignaturesForAddress', [
          holders[i].owner, { limit: 100 },
        ]);
        if (!sigs || sigs.length === 0) continue;

        // Check last 10 txs for SOL transfers to/from other holders
        for (const sigInfo of sigs.slice(0, 10)) {
          if (!sigInfo.signature) continue;
          try {
            const tx = await this.rpc.call('getTransaction', [
              sigInfo.signature,
              { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
            ]);
            if (!tx?.meta) continue;

            const keys = tx.transaction?.message?.accountKeys || [];
            const pre = tx.meta.preBalances || [];
            const post = tx.meta.postBalances || [];

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
                  timestamp: sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000) : null,
                  signature: sigInfo.signature,
                });
              }
            }
          } catch { continue; }
        }
      } catch { continue; }

      if ((i + 1) % 5 === 0 || i === holders.length - 1) {
        console.log(`   Transfer scan: ${i + 1}/${holders.length}`);
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

    console.log(`   Found ${unique.length} inter-holder transfers`);
    return unique;
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
   * @returns {Array<InsiderGroup>}
   */
  detectInsiderGroups(holders, similarityAnalysis, fundingAnalysis, interHolderTransfers = []) {
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
    if (fundingAnalysis?.clusters) {
      for (const cluster of fundingAnalysis.clusters) {
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

    // Signal 4: Inter-holder transfers
    for (const transfer of interHolderTransfers) {
      addConnection(transfer.from, transfer.to, 'SOL_TRANSFER', {
        amountSOL: transfer.amountSOL,
        timestamp: transfer.timestamp,
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
    const totalSupply = holders.reduce((s, h) => s + h.balance, 0);
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
        if (j >= 0.7) { confidence += 35; signals.push(`🔴 Token overlap sangat tinggi (J=${j.toFixed(2)}) — 35pts`); }
        else if (j >= 0.4) { confidence += 25; signals.push(`🟠 Token overlap tinggi (J=${j.toFixed(2)}) — 25pts`); }
        else if (j >= 0.15) { confidence += 15; signals.push(`🟡 Token overlap moderate (J=${j.toFixed(2)}) — 15pts`); }
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
        const totalSOL = groupEvidence.transfers.reduce((s, t) => s + t.amountSOL, 0);
        signals.push(`🔗 Transfer SOL antar-holder (${totalSOL.toFixed(4)} SOL total) — 20pts`);
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

      confidence = Math.min(100, confidence);

      // Supply controlled
      const groupBalance = walletList.reduce((s, w) => {
        const h = holderMap.get(w);
        return s + (h ? h.balance : 0);
      }, 0);
      const supplyPct = totalSupply > 0 ? (groupBalance / totalSupply * 100) : 0;

      // Confidence label
      let confidenceLabel;
      if (confidence >= 70) confidenceLabel = '🔴 SANGAT MUNGKIN INSIDER/TEAM';
      else if (confidence >= 45) confidenceLabel = '🟠 KEMUNGKINAN BESAR INSIDER';
      else if (confidence >= 25) confidenceLabel = '🟡 DICURIGAI TERKAIT';
      else confidenceLabel = '⚪ KONEKSI LEMAH';

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
  formatInsiderOutput(insiderGroups, holders, fundingAnalysis) {
    const lines = [];
    const totalBalance = holders.reduce((s, h) => s + h.balance, 0);
    const holderMap = new Map(holders.map(h => [h.owner, h]));

    lines.push('');
    lines.push('╔' + '═'.repeat(78) + '╗');
    lines.push('║  🕵️  SUSPECTED INSIDER / TEAM GROUPS                                         ║');
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
    lines.push(`  📊 ${insiderGroups.length} grup terdeteksi — ${totalInsiderWallets} wallets — ${totalInsiderSupply.toFixed(1)}% supply`);
    if (highConfidence > 0) {
      lines.push(`  ⚠️  ${highConfidence} grup dengan kepercayaan tinggi (≥45%)`);
    }
    lines.push('');

    for (let gi = 0; gi < insiderGroups.length; gi++) {
      const group = insiderGroups[gi];
      lines.push('  ┌' + '─'.repeat(76) + '┐');
      lines.push(`  │ GRUP #${gi + 1} — ${group.confidenceLabel}`);
      lines.push(`  │ Confidence: ${group.confidence}/100 | ${group.walletCount} wallets | ${group.supplyPct}% supply`);
      lines.push('  ├' + '─'.repeat(76) + '┤');

      // Signals (evidence)
      lines.push('  │ BUKTI:');
      for (const signal of group.signals) {
        lines.push(`  │   ${signal}`);
      }

      // Members
      lines.push('  │');
      lines.push('  │ ANGGOTA:');
      for (const wallet of group.wallets) {
        const h = holderMap.get(wallet);
        const pct = h && totalBalance > 0 ? (h.balance / totalBalance * 100).toFixed(1) : '?';
        const age = h?.walletAgeDays != null ? `${h.walletAgeDays}d` : '?';
        const tokens = h?.tokenCount ?? '?';
        const score = h?.riskData?.score ?? '?';
        lines.push(`  │   ${wallet}  ${pct}% | Age:${age} | Tok:${tokens} | Risk:${score}`);
      }

      // Shared tokens
      if (group.evidence.sharedTokens.size > 0) {
        lines.push('  │');
        lines.push(`  │ TOKEN YANG SAMA (${group.evidence.sharedTokens.size}):`);
        const tokenList = [...group.evidence.sharedTokens].slice(0, 5);
        for (const t of tokenList) {
          lines.push(`  │   • ${t}`);
        }
        if (group.evidence.sharedTokens.size > 5) {
          lines.push(`  │   ... +${group.evidence.sharedTokens.size - 5} lainnya`);
        }
      }

      // Funders
      if (group.evidence.funders.size > 0) {
        lines.push('  │');
        lines.push('  │ SUMBER DANA:');
        for (const funder of group.evidence.funders) {
          const label = getEntityLabel(funder) || '';
          lines.push(`  │   ← ${funder} ${label}`);
        }
      }

      // Transfers
      if (group.evidence.transfers.length > 0) {
        lines.push('  │');
        lines.push('  │ TRANSFER ANTAR-HOLDER:');
        for (const t of group.evidence.transfers) {
          const timeStr = t.timestamp
            ? t.timestamp.toISOString().replace('T', ' ').split('.')[0].slice(5)
            : '';
          lines.push(`  │   ${t.amountSOL.toFixed(4)} SOL ${timeStr ? `[${timeStr}]` : ''}`);
        }
      }

      lines.push('  └' + '─'.repeat(76) + '┘');
      lines.push('');
    }

    return lines.join('\n');
  }
}
