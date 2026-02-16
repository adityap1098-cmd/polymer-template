/**
 * Price & PnL Analyzer Module
 *
 * Detects entry prices from purchase transactions, fetches current prices
 * from Jupiter API, and calculates PnL for each holder.
 *
 * Features:
 * 1. Entry price extraction from on-chain swap transactions
 * 2. Current price via Jupiter Price API v2 (free, no auth)
 * 3. PnL calculation (SOL & USD) per holder
 * 4. Early buyer detection — bought cheap, still holding
 * 5. Cross-reference high-PnL holders with similarity/sybil groups
 *
 * References: Jupiter, DexScreener, GMGN, Bubblemaps
 */

import { getEntityLabel } from './knownEntities.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ─── Entry Price Extraction ─────────────────────────────────────────────────

/**
 * Extract entry price (SOL per token) from a purchase transaction.
 *
 * Approach:
 * - Token balance delta: postTokenBalances - preTokenBalances → tokens received
 * - SOL balance delta: preBalances - postBalances → SOL spent (lamports)
 * - Entry price = SOL spent / tokens received
 *
 * Works for Pump.fun, Raydium, Jupiter, Orca, and most DEX swaps.
 *
 * @param {object} tx - Full transaction object (jsonParsed encoding)
 * @param {string} wallet - Buyer wallet address
 * @param {string} tokenMint - Token mint address
 * @returns {object|null} { tokensReceived, solSpent, pricePerToken, decimals }
 */
export function extractEntryPriceFromTx(tx, wallet, tokenMint) {
  if (!tx?.meta) return null;

  const preTokenBal = tx.meta.preTokenBalances || [];
  const postTokenBal = tx.meta.postTokenBalances || [];

  // ─── Token balance change ───
  let postAmount = 0;
  let preAmount = 0;
  let decimals = 0;
  let found = false;

  for (const post of postTokenBal) {
    if (post.mint === tokenMint && post.owner === wallet) {
      postAmount = parseFloat(post.uiTokenAmount?.uiAmountString || post.uiTokenAmount?.uiAmount || '0');
      decimals = post.uiTokenAmount?.decimals || 0;
      found = true;
      break;
    }
  }

  if (!found) return null;

  for (const pre of preTokenBal) {
    if (pre.mint === tokenMint && pre.owner === wallet) {
      preAmount = parseFloat(pre.uiTokenAmount?.uiAmountString || pre.uiTokenAmount?.uiAmount || '0');
      break;
    }
  }

  const tokensReceived = postAmount - preAmount;
  if (tokensReceived <= 0) return null;

  // ─── SOL balance change ───
  // Find wallet index in accountKeys
  const accountKeys = tx.transaction?.message?.accountKeys || [];
  let walletIndex = -1;
  for (let i = 0; i < accountKeys.length; i++) {
    const key = typeof accountKeys[i] === 'string'
      ? accountKeys[i]
      : (accountKeys[i]?.pubkey || accountKeys[i]?.toString?.() || '');
    if (key === wallet) {
      walletIndex = i;
      break;
    }
  }

  let solSpent = 0;
  if (walletIndex >= 0 && tx.meta.preBalances && tx.meta.postBalances) {
    const preSol = (tx.meta.preBalances[walletIndex] || 0) / 1e9;
    const postSol = (tx.meta.postBalances[walletIndex] || 0) / 1e9;
    solSpent = preSol - postSol;

    // Subtract tx fee to get pure SOL spent on the swap
    const fee = (tx.meta.fee || 0) / 1e9;
    solSpent = solSpent - fee;
  }

  // If SOL spent is negative or zero, the buyer might have used WSOL
  // In that case, try to find WSOL (native SOL) token balance changes
  if (solSpent <= 0) {
    for (const pre of preTokenBal) {
      if (pre.mint === SOL_MINT && pre.owner === wallet) {
        const preWsol = parseFloat(pre.uiTokenAmount?.uiAmountString || pre.uiTokenAmount?.uiAmount || '0');
        let postWsol = 0;
        for (const post of postTokenBal) {
          if (post.mint === SOL_MINT && post.owner === wallet) {
            postWsol = parseFloat(post.uiTokenAmount?.uiAmountString || post.uiTokenAmount?.uiAmount || '0');
            break;
          }
        }
        solSpent = preWsol - postWsol;
        break;
      }
    }
  }

  // Entry price = SOL spent / tokens received
  const pricePerToken = solSpent > 0 && tokensReceived > 0
    ? solSpent / tokensReceived
    : 0;

  return {
    tokensReceived,
    solSpent: Math.max(0, solSpent),
    pricePerToken,
    decimals,
  };
}

// ─── Price Fetcher (Multi-source: DexScreener → Jupiter fallback) ───────────

/**
 * Get current token price.
 *
 * Sources (tried in order):
 * 1. DexScreener /tokens/v1 — free, no auth, returns priceUsd for any Solana pair
 * 2. Jupiter Price API v2 — may require API key in some regions
 *
 * Returns prices in USD. Also fetches SOL price for conversion.
 *
 * @param {string} tokenMint - Token mint address
 * @returns {Promise<object|null>} { priceUSD, solPriceUSD, priceSOL }
 */
export async function getCurrentPrice(tokenMint) {
  // ── Source 1: DexScreener (free, reliable) ──
  try {
    const result = await _fetchDexScreenerPrice(tokenMint);
    if (result) return result;
  } catch { /* fall through */ }

  // ── Source 2: Jupiter Price API v2 (fallback) ──
  try {
    const result = await _fetchJupiterPrice(tokenMint);
    if (result) return result;
  } catch { /* fall through */ }

  console.log('  ⚠️ All price sources failed');
  return null;
}

/**
 * Fetch price from DexScreener /tokens/v1/solana/{address}
 * Returns the highest-liquidity pair's price.
 * @private
 */
async function _fetchDexScreenerPrice(tokenMint) {
  // Fetch token price + SOL price in parallel
  const [tokenResp, solResp] = await Promise.all([
    fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    }),
    fetch(`https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    }),
  ]);

  if (!tokenResp.ok) {
    console.log(`  ⚠️ DexScreener returned ${tokenResp.status}`);
    return null;
  }

  const tokenPairs = await tokenResp.json();
  const solPairs = solResp.ok ? await solResp.json() : [];

  // DexScreener returns array of pairs sorted by liquidity
  // Pick the first pair where our token is the baseToken
  let tokenPair = null;
  if (Array.isArray(tokenPairs) && tokenPairs.length > 0) {
    // Prefer pair where our token is baseToken (priceUsd = our token's price)
    tokenPair = tokenPairs.find(p => p.baseToken?.address === tokenMint) || tokenPairs[0];
  }

  if (!tokenPair?.priceUsd) {
    console.log('  ⚠️ No DexScreener price data for this token');
    return null;
  }

  // If our token is the quoteToken, we need to invert the price
  let priceUSD;
  if (tokenPair.baseToken?.address === tokenMint) {
    priceUSD = parseFloat(tokenPair.priceUsd);
  } else {
    // Token is quoteToken — priceUsd is for baseToken, need to invert
    const basePrice = parseFloat(tokenPair.priceUsd);
    const nativePrice = parseFloat(tokenPair.priceNative || '0');
    priceUSD = nativePrice > 0 ? basePrice / nativePrice : 0;
  }

  // Get SOL price from SOL pairs
  let solPriceUSD = 0;
  if (Array.isArray(solPairs) && solPairs.length > 0) {
    const solPair = solPairs.find(p => p.baseToken?.address === SOL_MINT) || solPairs[0];
    if (solPair?.priceUsd) {
      solPriceUSD = solPair.baseToken?.address === SOL_MINT
        ? parseFloat(solPair.priceUsd)
        : 0;
    }
  }

  // Fallback SOL price from the token pair's native price ratio
  if (solPriceUSD === 0 && tokenPair.priceUsd && tokenPair.priceNative) {
    const usd = parseFloat(tokenPair.priceUsd);
    const native = parseFloat(tokenPair.priceNative);
    if (native > 0) solPriceUSD = usd / native;
  }

  const priceSOL = solPriceUSD > 0 ? priceUSD / solPriceUSD : 0;

  console.log(`  ✅ DexScreener: ${priceUSD.toExponential(2)} USD | SOL=$${solPriceUSD.toFixed(2)}`);
  return { priceUSD, solPriceUSD, priceSOL };
}

/**
 * Fetch price from Jupiter Price API v2 (fallback).
 * @private
 */
async function _fetchJupiterPrice(tokenMint) {
  const url = `https://api.jup.ag/price/v2?ids=${tokenMint},${SOL_MINT}`;
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    console.log(`  ⚠️ Jupiter API returned ${response.status}`);
    return null;
  }

  const data = await response.json();
  const tokenData = data?.data?.[tokenMint];
  const solData = data?.data?.[SOL_MINT];

  if (!tokenData?.price) {
    console.log('  ⚠️ No price data from Jupiter for this token');
    return null;
  }

  const priceUSD = parseFloat(tokenData.price);
  const solPriceUSD = solData?.price ? parseFloat(solData.price) : 0;
  const priceSOL = solPriceUSD > 0 ? priceUSD / solPriceUSD : 0;

  console.log(`  ✅ Jupiter: ${priceUSD.toExponential(2)} USD | SOL=$${solPriceUSD.toFixed(2)}`);
  return { priceUSD, solPriceUSD, priceSOL };
}

// ─── PnL Calculation ────────────────────────────────────────────────────────

/**
 * Calculate PnL for a single holder.
 *
 * @param {object} holder - Holder object with entryPriceSol and balance
 * @param {object} currentPrice - { priceUSD, solPriceUSD, priceSOL }
 * @returns {object|null} PnL data
 */
export function calculateHolderPnL(holder, currentPrice) {
  if (!currentPrice || !holder.entryPriceSol || holder.entryPriceSol <= 0) return null;

  const entryPrice = holder.entryPriceSol;
  const currentPriceSOL = currentPrice.priceSOL;
  const holdings = holder.balance;

  if (!currentPriceSOL || currentPriceSOL <= 0) return null;

  const costBasisSOL = entryPrice * holdings;
  const currentValueSOL = currentPriceSOL * holdings;
  const pnlSOL = currentValueSOL - costBasisSOL;
  const pnlPercent = costBasisSOL > 0 ? ((currentValueSOL / costBasisSOL) - 1) * 100 : 0;

  // USD values
  const solPriceUSD = currentPrice.solPriceUSD || 0;
  const costBasisUSD = costBasisSOL * solPriceUSD;
  const currentValueUSD = currentValueSOL * solPriceUSD;
  const pnlUSD = currentValueUSD - costBasisUSD;

  // Multiplier (e.g., 10x, 100x)
  const multiplier = costBasisSOL > 0 ? currentValueSOL / costBasisSOL : 0;

  return {
    entryPriceSOL: entryPrice,
    currentPriceSOL,
    costBasisSOL,
    currentValueSOL,
    pnlSOL,
    pnlPercent,
    multiplier,
    costBasisUSD,
    currentValueUSD,
    pnlUSD,
    holdings,
  };
}

// ─── Early Buyer Detection ──────────────────────────────────────────────────

/**
 * Analyze holders to find early buyers, top PnL traders, and cross-reference
 * with similarity/sybil groups.
 *
 * @param {Array} holders - Holder array with entryPriceSol set
 * @param {object} currentPrice - From getCurrentPrice()
 * @param {object|null} similarityAnalysis - From analyzeHolderSimilarities()
 * @param {object|null} fundingAnalysis - From FundingAnalyzer
 * @returns {object} Analysis result
 */
export function analyzeEarlyBuyers(holders, currentPrice, similarityAnalysis = null, fundingAnalysis = null) {
  if (!currentPrice) {
    return { earlyBuyers: [], topPnL: [], crossReferences: [], currentPrice: null };
  }

  // Calculate PnL for each holder
  const holdersWithPnL = [];
  for (const holder of holders) {
    const pnl = calculateHolderPnL(holder, currentPrice);
    if (pnl) {
      holdersWithPnL.push({ ...holder, pnl });
    }
  }

  // Sort by PnL% descending → top profitable
  const topPnL = [...holdersWithPnL]
    .sort((a, b) => b.pnl.pnlPercent - a.pnl.pnlPercent);

  // Early buyers: bought at <10% of current price AND still holding significant amount
  const totalBalance = holders.reduce((s, h) => s + h.balance, 0);
  const earlyBuyers = holdersWithPnL.filter(h => {
    const boughtCheap = h.pnl.multiplier >= 5; // 5x+ profit = bought very early
    const significantHolding = totalBalance > 0 ? (h.balance / totalBalance * 100) >= 0.5 : false;
    return boughtCheap && significantHolding;
  }).sort((a, b) => b.pnl.multiplier - a.pnl.multiplier);

  // Cross-reference: high-PnL holders in similarity/sybil groups
  const crossReferences = [];

  // Check sybil clusters
  if (fundingAnalysis?.clusters) {
    for (const cluster of fundingAnalysis.clusters) {
      const clusterPnLHolders = holdersWithPnL.filter(h =>
        cluster.wallets.includes(h.owner) && h.pnl.pnlPercent > 50,
      );
      if (clusterPnLHolders.length >= 2) {
        crossReferences.push({
          type: 'SYBIL_CLUSTER',
          description: `${clusterPnLHolders.length} profitable wallets in same sybil cluster`,
          wallets: clusterPnLHolders.map(h => h.owner),
          avgPnLPercent: clusterPnLHolders.reduce((s, h) => s + h.pnl.pnlPercent, 0) / clusterPnLHolders.length,
          signal: 'STRONG',
        });
      }
    }
  }

  // Check similarity groups
  if (similarityAnalysis?.groups) {
    for (const group of similarityAnalysis.groups) {
      const groupPnLHolders = holdersWithPnL.filter(h =>
        group.wallets.includes(h.owner) && h.pnl.pnlPercent > 50,
      );
      if (groupPnLHolders.length >= 2) {
        crossReferences.push({
          type: 'SIMILARITY_GROUP',
          description: `${groupPnLHolders.length} profitable wallets share trading patterns (J=${group.avgJaccard})`,
          wallets: groupPnLHolders.map(h => h.owner),
          avgPnLPercent: groupPnLHolders.reduce((s, h) => s + h.pnl.pnlPercent, 0) / groupPnLHolders.length,
          jaccard: group.avgJaccard,
          signal: group.avgJaccard >= 0.3 ? 'STRONG' : 'MODERATE',
        });
      }
    }
  }

  return {
    holdersWithPnL,
    earlyBuyers,
    topPnL,
    crossReferences,
    currentPrice,
    totalAnalyzed: holdersWithPnL.length,
    totalHolders: holders.length,
  };
}

// ─── Output Formatter ───────────────────────────────────────────────────────

/**
 * Format SOL amount with appropriate precision.
 */
function fmtSOL(val) {
  if (val === null || val === undefined || isNaN(val)) return '?';
  if (Math.abs(val) < 0.000001) return val.toExponential(2);
  if (Math.abs(val) < 0.001) return val.toFixed(8);
  if (Math.abs(val) < 1) return val.toFixed(6);
  if (Math.abs(val) < 1000) return val.toFixed(4);
  return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Format USD amount.
 */
function fmtUSD(val) {
  if (val === null || val === undefined || isNaN(val)) return '?';
  if (Math.abs(val) < 0.01) return `$${val.toExponential(2)}`;
  if (Math.abs(val) < 1) return `$${val.toFixed(4)}`;
  return `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format multiplier (e.g., 10.5x).
 */
function fmtMultiplier(val) {
  if (val === null || val === undefined || isNaN(val) || val <= 0) return '?';
  if (val >= 1000) return `${Math.round(val)}x`;
  if (val >= 10) return `${val.toFixed(1)}x`;
  return `${val.toFixed(2)}x`;
}

/**
 * Format PnL percentage with color indicator.
 */
function fmtPnLPercent(val) {
  if (val === null || val === undefined || isNaN(val)) return '?';
  const sign = val >= 0 ? '+' : '';
  if (Math.abs(val) >= 1000) return `${sign}${Math.round(val)}%`;
  return `${sign}${val.toFixed(1)}%`;
}

/**
 * Format comprehensive PnL analysis output.
 *
 * @param {object} pnlAnalysis - From analyzeEarlyBuyers()
 * @param {Array} holders - All holders (for percentage calculation)
 * @returns {string} Formatted output
 */
export function formatPnLOutput(pnlAnalysis, holders = []) {
  if (!pnlAnalysis || !pnlAnalysis.currentPrice) {
    return '\n⚠️  Price data unavailable — PnL analysis skipped.\n';
  }

  const lines = [];
  const totalBalance = holders.reduce((s, h) => s + h.balance, 0);
  const cp = pnlAnalysis.currentPrice;

  lines.push('');
  lines.push('╔' + '═'.repeat(78) + '╗');
  lines.push('║  💰 ENTRY PRICE & PnL ANALYSIS                                               ║');
  lines.push('╚' + '═'.repeat(78) + '╝');
  lines.push(`  Current Price:  ${fmtSOL(cp.priceSOL)} SOL (${fmtUSD(cp.priceUSD)})`);
  lines.push(`  SOL Price:      ${fmtUSD(cp.solPriceUSD)}`);
  lines.push(`  Analyzed:       ${pnlAnalysis.totalAnalyzed}/${pnlAnalysis.totalHolders} holders (entry price detected)`);
  lines.push('');

  // ── EARLY BUYERS (bought cheap, still holding) ──
  if (pnlAnalysis.earlyBuyers.length > 0) {
    lines.push('  🏆 EARLY BUYERS — Beli murah, masih hold');
    lines.push('  ' + '─'.repeat(74));
    lines.push('  Mult.  | PnL%       | Entry (SOL)      | Holdings %  | Wallet');
    lines.push('  ' + '─'.repeat(74));

    for (const h of pnlAnalysis.earlyBuyers.slice(0, 15)) {
      const pct = totalBalance > 0 ? (h.balance / totalBalance * 100).toFixed(1) : '?';
      const mult = fmtMultiplier(h.pnl.multiplier).padEnd(6);
      const pnlPct = fmtPnLPercent(h.pnl.pnlPercent).padEnd(10);
      const entry = fmtSOL(h.pnl.entryPriceSOL).padEnd(16);
      const holdPct = `${pct}%`.padEnd(10);
      lines.push(`  ${mult} | ${pnlPct} | ${entry} | ${holdPct} | ${h.owner}`);
    }
    lines.push('');
  }

  // ── TOP PnL (all profitable holders, sorted by PnL%) ──
  const profitable = pnlAnalysis.topPnL.filter(h => h.pnl.pnlPercent > 0);
  const losing = pnlAnalysis.topPnL.filter(h => h.pnl.pnlPercent <= 0);

  if (profitable.length > 0) {
    lines.push('  📈 TOP PROFITABLE HOLDERS — Sorted by PnL%');
    lines.push('  ' + '─'.repeat(74));
    lines.push('  PnL%       | Entry (SOL)      | Value (SOL)   | PnL (SOL)    | Wallet');
    lines.push('  ' + '─'.repeat(74));

    for (const h of profitable.slice(0, 20)) {
      const pnlPct = fmtPnLPercent(h.pnl.pnlPercent).padEnd(10);
      const entry = fmtSOL(h.pnl.entryPriceSOL).padEnd(16);
      const value = fmtSOL(h.pnl.currentValueSOL).padEnd(13);
      const pnl = fmtSOL(h.pnl.pnlSOL).padEnd(12);
      lines.push(`  ${pnlPct} | ${entry} | ${value} | ${pnl} | ${h.owner}`);
    }
    lines.push('');
  }

  // Show losers briefly
  if (losing.length > 0) {
    lines.push(`  📉 LOSING HOLDERS — ${losing.length} wallet(s) currently at loss`);
    lines.push('  ' + '─'.repeat(74));
    for (const h of losing.slice(0, 10)) {
      const pnlPct = fmtPnLPercent(h.pnl.pnlPercent).padEnd(10);
      const entry = fmtSOL(h.pnl.entryPriceSOL).padEnd(16);
      lines.push(`  ${pnlPct} | Entry: ${entry} | ${h.owner}`);
    }
    lines.push('');
  }

  // ── CROSS-REFERENCES ──
  if (pnlAnalysis.crossReferences.length > 0) {
    lines.push('  🚨 CROSS-REFERENCE — Profitable wallets in suspicious groups');
    lines.push('  ' + '─'.repeat(74));

    for (const ref of pnlAnalysis.crossReferences) {
      const signal = ref.signal === 'STRONG' ? '🔴' : '🟡';
      lines.push(`\n  ${signal} ${ref.description}`);
      lines.push(`     Avg PnL: ${fmtPnLPercent(ref.avgPnLPercent)} | Type: ${ref.type}`);
      for (const wallet of ref.wallets) {
        const h = holders.find(hh => hh.owner === wallet);
        const pct = h && totalBalance > 0 ? (h.balance / totalBalance * 100).toFixed(1) : '?';
        lines.push(`     ${wallet}  (${pct}%)`);
      }
    }
    lines.push('');
  }

  // ── SUMMARY ──
  const profitCount = profitable.length;
  const lossCount = losing.length;
  const earlyCount = pnlAnalysis.earlyBuyers.length;
  const crossCount = pnlAnalysis.crossReferences.length;

  lines.push('  ' + '─'.repeat(74));
  lines.push(`  Ringkasan: ${profitCount} profit | ${lossCount} rugi | ${earlyCount} early buyer | ${crossCount} cross-ref alert`);

  if (earlyCount > 0 && crossCount > 0) {
    lines.push('  ⚠️  PERHATIAN: Ada early buyers yang terdeteksi di kelompok mencurigakan!');
  } else if (earlyCount >= 3) {
    lines.push('  ⚠️  Banyak early buyers masih hold — potensi insider/sniper.');
  }

  lines.push('');

  return lines.join('\n');
}

export { SOL_MINT };
