/**
 * Wallet Analyzer Module for Solana Wallet Checker Bot.
 * Analyzes wallet history and classifies wallets as OLD, SEMI-NEW, or FRESH.
 * 
 * Uses custom rate-limited RPC client to avoid 429 spam.
 */

import { RateLimitedRPC } from './rateLimiter.js';
import { isUniversalToken } from './knownEntities.js';

/** Wallet classification types */
export const WalletType = {
  FRESH: 'FRESH',       // No other token transactions except current
  SEMI_NEW: 'SEMI_NEW', // Less than 5 different token transactions
  OLD: 'OLD',           // 5 or more different token transactions
};

/** Wallet profile tags (new modern approach) */
export const WalletProfile = {
  ORGANIC: 'ORGANIC',       // Normal human trader
  SNIPER_BOT: 'SNIPER_BOT', // Extremely fast, low-diversity trading
  COPY_TRADER: 'COPY_TRADER', // Follows other wallets' trades closely
  DORMANT: 'DORMANT',        // Old wallet, very low recent activity
  FRESH_FUNDED: 'FRESH_FUNDED', // Brand new, just received SOL
};

/** Solana Token Program IDs */
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export class WalletAnalyzer {
  /**
   * @param {string} rpcUrl - Solana RPC endpoint URL
   * @param {number} oldWalletThreshold - Number of unique tokens to classify as OLD wallet
   */
  constructor(rpcUrl, oldWalletThreshold = 5) {
    this.rpc = new RateLimitedRPC(rpcUrl, 12);
    this.oldWalletThreshold = oldWalletThreshold;
  }

  /**
   * Get transaction signatures for a wallet address.
   * @param {string} address 
   * @param {number} limit 
   * @returns {Promise<Array>}
   */
  async getSignaturesForAddress(address, limit = 100) {
    try {
      const result = await this.rpc.call('getSignaturesForAddress', [address, { limit }]);
      return result || [];
    } catch (err) {
      throw new Error(`Failed to get signatures: ${err.message}`);
    }
  }

  /**
   * Get parsed transaction details.
   * @param {string} signature 
   * @returns {Promise<object|null>}
   */
  async getTransaction(signature) {
    try {
      return await this.rpc.call('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);
    } catch (err) {
      return null;
    }
  }

  /**
   * Count unique tokens using getTokenAccountsByOwner (accurate) +
   * find first transaction time and initial funder via signature pagination.
   * @param {string} address 
   * @param {string|null} currentToken - Token to exclude from count
   * @returns {Promise<{uniqueTokenCount: number, firstTxTime: Date|null, initialFunder: string|null}>}
   */
  async _countUniqueTokensFromTransactions(address, currentToken = null) {
    const uniqueTokens = new Set();
    let firstTxTime = null;
    let initialFunder = null;

    // ── Step 1: Get accurate token count via getTokenAccountsByOwner ──
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        const result = await this.rpc.call('getTokenAccountsByOwner', [
          address,
          { programId },
          { encoding: 'jsonParsed' },
        ]);
        if (result?.value) {
          for (const acct of result.value) {
            const info = acct.account?.data?.parsed?.info;
            if (!info?.mint) continue;
            const mint = info.mint;
            if (mint === currentToken) continue;
            if (isUniversalToken(mint)) continue;
            const amount = parseFloat(info.tokenAmount?.uiAmount || '0');
            if (amount > 0) uniqueTokens.add(mint);
          }
        }
      } catch { /* skip */ }
    }

    // ── Step 2: Find true oldest tx via signature pagination (up to 3000 txs) ──
    try {
      let before = undefined;
      let oldestSig = null;
      const MAX_PAGES = 3;

      for (let page = 0; page < MAX_PAGES; page++) {
        const opts = { limit: 1000 };
        if (before) opts.before = before;
        const sigs = await this.rpc.call('getSignaturesForAddress', [address, opts]);
        if (!sigs || sigs.length === 0) break;

        oldestSig = sigs[sigs.length - 1];
        if (sigs.length < 1000) break;
        before = oldestSig.signature;
      }

      if (oldestSig) {
        firstTxTime = oldestSig.blockTime
          ? new Date(oldestSig.blockTime * 1000)
          : null;

        // Find initial funder from oldest transaction
        try {
          const oldestTx = await this.getTransaction(oldestSig.signature);
          if (oldestTx?.meta) {
            const preBalances = oldestTx.meta.preBalances || [];
            const postBalances = oldestTx.meta.postBalances || [];
            const accountKeys = oldestTx.transaction?.message?.accountKeys || [];

            for (let i = 0; i < preBalances.length; i++) {
              if (preBalances[i] > postBalances[i] && i < accountKeys.length) {
                const key = accountKeys[i];
                const funderAddress = typeof key === 'object' ? key.pubkey?.toString() : key?.toString();
                if (funderAddress && funderAddress !== address) {
                  initialFunder = funderAddress;
                  break;
                }
              }
            }
          }
        } catch {
          // Ignore error on funder detection
        }
      }
    } catch {
      // Ignore pagination errors
    }

    return { uniqueTokenCount: uniqueTokens.size, firstTxTime, initialFunder };
  }

  /**
   * Classify wallet based on unique token count.
   * @param {number} uniqueTokenCount 
   * @returns {string}
   */
  _classifyWallet(uniqueTokenCount) {
    if (uniqueTokenCount === 0) return WalletType.FRESH;
    if (uniqueTokenCount < this.oldWalletThreshold) return WalletType.SEMI_NEW;
    return WalletType.OLD;
  }

  /**
   * Analyze a wallet and return its classification with enhanced metrics.
   * @param {string} address 
   * @param {string|null} currentToken 
   * @returns {Promise<object>}
   */
  async analyzeWallet(address, currentToken = null) {
    // Count unique tokens from transaction history
    const { uniqueTokenCount, firstTxTime, initialFunder } =
      await this._countUniqueTokensFromTransactions(address, currentToken);

    // Get total transaction count
    const signatures = await this.getSignaturesForAddress(address, 100);
    const totalTransactions = signatures ? signatures.length : 0;

    // Get current balance
    let currentBalance = null;
    try {
      const lamports = await this.rpc.call('getBalance', [address]);
      if (lamports && typeof lamports === 'object' && 'value' in lamports) {
        currentBalance = lamports.value / 1e9;
      } else if (typeof lamports === 'number') {
        currentBalance = lamports / 1e9;
      }
    } catch (err) {
      // Ignore
    }

    // Classify wallet
    const walletType = this._classifyWallet(uniqueTokenCount);

    // ── Enhanced: Wallet age & activity frequency ──
    let walletAgeDays = null;
    let txPerDay = 0;
    if (firstTxTime) {
      walletAgeDays = Math.max(1, Math.round((Date.now() - firstTxTime.getTime()) / 86400000));
      txPerDay = Math.round(totalTransactions / walletAgeDays * 100) / 100;
    }

    // ── Enhanced: Wallet profiling ──
    const profile = this._profileWallet({
      uniqueTokenCount,
      walletAgeDays,
      txPerDay,
      totalTransactions,
    });

    return {
      address,
      walletType,
      uniqueTokenCount,
      firstTransactionTime: firstTxTime,
      initialFunder,
      currentBalance,
      totalTransactions,
      // Enhanced fields:
      walletAgeDays,
      txPerDay,
      profile,
    };
  }

  /**
   * Profile a wallet based on behavioral heuristics (modern approach).
   * @param {object} metrics
   * @returns {string}
   */
  _profileWallet({ uniqueTokenCount, walletAgeDays, txPerDay, totalTransactions }) {
    if (walletAgeDays !== null && walletAgeDays <= 1 && totalTransactions <= 3) {
      return WalletProfile.FRESH_FUNDED;
    }
    if (txPerDay > 50 && uniqueTokenCount <= 3) {
      return WalletProfile.SNIPER_BOT;
    }
    if (walletAgeDays !== null && walletAgeDays > 180 && txPerDay < 0.1) {
      return WalletProfile.DORMANT;
    }
    return WalletProfile.ORGANIC;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
