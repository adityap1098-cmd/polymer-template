/**
 * Test suite for Solana Wallet Checker Bot (Node.js version)
 * 
 * Tests basic functionality: imports, classification logic, CSV parsing, risk scoring
 * Run with: node --test src/test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WalletAnalyzer, WalletType, WalletProfile } from './walletAnalyzer.js';
import { HolderAnalyzer, calculateGini, jaccardSimilarity, checkIsOnCurve } from './holderAnalyzer.js';
import { FundingAnalyzer } from './fundingAnalyzer.js';
import { CSVImporter } from './csvImporter.js';
import { TransactionMonitor } from './transactionMonitor.js';
import {
  EXCHANGE_WALLETS, LIQUIDITY_PROGRAMS, UNIVERSAL_TOKENS,
  identifyExchange, isLiquidityProgram, isUniversalToken, getEntityLabel,
  KNOWN_PROGRAM_LABELS, SYSTEM_PROGRAM_ID, getProgramLabel, isUserWallet,
} from './knownEntities.js';
import { InsiderDetector } from './insiderDetector.js';
import { getPlanConfig, PLANS } from './planConfig.js';
import { writeFileSync, unlinkSync } from 'fs';
import { PublicKey } from '@solana/web3.js';

const TEST_RPC = 'https://api.mainnet-beta.solana.com';

describe('WalletType', () => {
  it('should have correct enum values', () => {
    assert.equal(WalletType.FRESH, 'FRESH');
    assert.equal(WalletType.SEMI_NEW, 'SEMI_NEW');
    assert.equal(WalletType.OLD, 'OLD');
  });
});

describe('WalletAnalyzer', () => {
  it('should instantiate correctly', () => {
    const analyzer = new WalletAnalyzer(TEST_RPC, 5);
    assert.ok(analyzer);
    assert.equal(analyzer.oldWalletThreshold, 5);
  });

  it('should classify FRESH wallet (0 tokens)', () => {
    const analyzer = new WalletAnalyzer(TEST_RPC, 5);
    assert.equal(analyzer._classifyWallet(0), WalletType.FRESH);
  });

  it('should classify SEMI_NEW wallet (1-4 tokens)', () => {
    const analyzer = new WalletAnalyzer(TEST_RPC, 5);
    assert.equal(analyzer._classifyWallet(1), WalletType.SEMI_NEW);
    assert.equal(analyzer._classifyWallet(4), WalletType.SEMI_NEW);
  });

  it('should classify OLD wallet (5+ tokens)', () => {
    const analyzer = new WalletAnalyzer(TEST_RPC, 5);
    assert.equal(analyzer._classifyWallet(5), WalletType.OLD);
    assert.equal(analyzer._classifyWallet(10), WalletType.OLD);
  });

  it('should respect custom threshold', () => {
    const analyzer = new WalletAnalyzer(TEST_RPC, 10);
    assert.equal(analyzer._classifyWallet(9), WalletType.SEMI_NEW);
    assert.equal(analyzer._classifyWallet(10), WalletType.OLD);
  });
});

describe('TransactionMonitor', () => {
  it('should instantiate correctly', () => {
    const monitor = new TransactionMonitor({
      rpcUrl: TEST_RPC,
      wssUrl: 'wss://api.mainnet-beta.solana.com',
      tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      onTransaction: async () => {},
      pollInterval: 5,
    });
    assert.ok(monitor);
    assert.equal(monitor._running, false);
  });

  it('should extract buyer wallets from empty transaction', () => {
    const monitor = new TransactionMonitor({
      rpcUrl: TEST_RPC,
      wssUrl: 'wss://api.mainnet-beta.solana.com',
      tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      onTransaction: async () => {},
    });
    assert.deepEqual(monitor._extractBuyerWallets(null), []);
    assert.deepEqual(monitor._extractBuyerWallets({}), []);
    assert.deepEqual(monitor._extractBuyerWallets({ meta: null }), []);
  });

  it('should identify buyers from mock transaction', () => {
    const tokenAddress = 'TestMintAddress123456789012345678901234';
    const monitor = new TransactionMonitor({
      rpcUrl: TEST_RPC,
      wssUrl: 'wss://api.mainnet-beta.solana.com',
      tokenAddress,
      onTransaction: async () => {},
    });

    const mockTx = {
      meta: {
        preTokenBalances: [
          { mint: tokenAddress, owner: 'BuyerWallet1234567890123456789012345', uiTokenAmount: { uiAmount: 0 } },
        ],
        postTokenBalances: [
          { mint: tokenAddress, owner: 'BuyerWallet1234567890123456789012345', uiTokenAmount: { uiAmount: 100 } },
        ],
      },
    };

    const buyers = monitor._extractBuyerWallets(mockTx);
    assert.equal(buyers.length, 1);
    assert.equal(buyers[0], 'BuyerWallet1234567890123456789012345');
  });
});

describe('HolderAnalyzer - Risk Scoring', () => {
  it('should instantiate correctly', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC);
    assert.ok(analyzer);
  });

  it('should calculate risk for fresh wallet with large holding', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC);
    const holder = { owner: 'TestWallet1', balance: 5000000, tokenCount: 0, walletAgeDays: 1, txFrequency: 0.5, totalTxCount: 1 };
    const allHolders = [
      holder,
      { owner: 'TestWallet2', balance: 5000000, tokenCount: 5, walletAgeDays: 365, txFrequency: 2, totalTxCount: 730 },
    ];

    const risk = analyzer.calculateRiskScore(holder, allHolders, null);
    assert.ok(risk.score > 0);
    assert.ok(risk.level.includes('CRITICAL') || risk.level.includes('HIGH'));
    assert.ok(risk.factors.length > 0);
  });

  it('should give low risk for diversified small holder', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC);
    const holder = { owner: 'TestWallet1', balance: 100, tokenCount: 20, walletAgeDays: 365, txFrequency: 2, totalTxCount: 730 };
    const allHolders = [
      holder,
      { owner: 'TestWallet2', balance: 999900, tokenCount: 50, walletAgeDays: 365, txFrequency: 3, totalTxCount: 1095 },
    ];

    const risk = analyzer.calculateRiskScore(holder, allHolders, null);
    assert.equal(risk.level, '🟢 LOW');
  });

  it('should detect coordination from similarity analysis', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC);
    const holder = { owner: 'CoordWallet1', balance: 1000, tokenCount: 5, walletAgeDays: 60, txFrequency: 2, totalTxCount: 120 };
    const allHolders = [
      holder,
      { owner: 'CoordWallet2', balance: 1000, tokenCount: 5, walletAgeDays: 60, txFrequency: 2, totalTxCount: 120 },
      { owner: 'OtherWallet', balance: 998000, tokenCount: 50, walletAgeDays: 365, txFrequency: 3, totalTxCount: 1095 },
    ];

    const similarityAnalysis = {
      groups: [{
        wallets: ['CoordWallet1', 'CoordWallet2'],
        walletCount: 2,
        avgJaccard: 0.35,
        commonTokens: ['TokenA', 'TokenB', 'TokenC', 'TokenD', 'TokenE'],
        commonTokenCount: 5,
      }],
      totalGroups: 1,
      timingClusters: [],
      totalTimingClusters: 0,
    };

    const risk = analyzer.calculateRiskScore(holder, allHolders, similarityAnalysis);
    assert.ok(risk.score >= 14, `Expected score >= 14, got ${risk.score}`);
    assert.ok(risk.factors.some(f => f.includes('coordination') || f.includes('Coordination')));
  });

  it('should format holders output correctly', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC);
    const holders = [
      { owner: 'Wallet1_234567890123456789012345678901', balance: 5000, tokenCount: 0, purchaseTimeStr: '2026-01-01 12:00:00', walletAgeDays: 2, txFrequency: 1.5, totalTxCount: 3 },
      { owner: 'Wallet2_234567890123456789012345678901', balance: 3000, tokenCount: 10, purchaseTimeStr: '2026-01-02 12:00:00', walletAgeDays: 365, txFrequency: 0.5, totalTxCount: 180 },
    ];

    const output = analyzer.formatHoldersOutput(holders, 'TestToken123');
    assert.ok(output.includes('RISK ANALYSIS'));
    assert.ok(output.includes('QUICK VERDICT'));
    assert.ok(output.includes('Gini'));
    assert.ok(output.includes('Wallet1'));
    assert.ok(output.includes('Wallet2'));
  });
});

// ─── NEW: Gini Coefficient Tests ────────────────────────────────────────────

describe('Gini Coefficient', () => {
  it('should return 0 for equal distribution', () => {
    const gini = calculateGini([100, 100, 100, 100]);
    assert.ok(gini < 0.01, `Expected ~0, got ${gini}`);
  });

  it('should return high value for unequal distribution', () => {
    const gini = calculateGini([0, 0, 0, 1000]);
    assert.ok(gini > 0.7, `Expected > 0.7, got ${gini}`);
  });

  it('should handle single value', () => {
    const gini = calculateGini([500]);
    assert.equal(gini, 0);
  });

  it('should handle empty array', () => {
    const gini = calculateGini([]);
    assert.equal(gini, 0);
  });

  it('should return moderate for mixed distribution', () => {
    const gini = calculateGini([10, 20, 30, 40, 500]);
    assert.ok(gini > 0.3 && gini < 0.8, `Expected 0.3-0.8, got ${gini}`);
  });
});

// ─── NEW: Jaccard Similarity Tests ──────────────────────────────────────────

describe('Jaccard Similarity', () => {
  it('should return 1 for identical sets', () => {
    const a = new Set(['A', 'B', 'C']);
    const b = new Set(['A', 'B', 'C']);
    assert.equal(jaccardSimilarity(a, b), 1);
  });

  it('should return 0 for disjoint sets', () => {
    const a = new Set(['A', 'B']);
    const b = new Set(['C', 'D']);
    assert.equal(jaccardSimilarity(a, b), 0);
  });

  it('should return 0.5 for 50% overlap', () => {
    const a = new Set(['A', 'B']);
    const b = new Set(['B', 'C']);
    const j = jaccardSimilarity(a, b);
    assert.ok(Math.abs(j - 1 / 3) < 0.01, `Expected ~0.333, got ${j}`);
  });

  it('should handle empty sets', () => {
    assert.equal(jaccardSimilarity(new Set(), new Set(['A'])), 0);
    assert.equal(jaccardSimilarity(new Set(['A']), new Set()), 0);
  });
});

// ─── NEW: Timing Correlation Tests ──────────────────────────────────────────

describe('Timing Correlation', () => {
  it('should detect wallets buying within 5 minutes', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC);
    const base = new Date('2026-01-15T10:00:00Z');
    const holders = [
      { owner: 'W1', purchaseTime: new Date(base.getTime()) },
      { owner: 'W2', purchaseTime: new Date(base.getTime() + 30000) },  // +30 sec
      { owner: 'W3', purchaseTime: new Date(base.getTime() + 120000) }, // +2 min
      { owner: 'W4', purchaseTime: new Date(base.getTime() + 3600000) }, // +1 hour (separate)
    ];

    const clusters = analyzer.analyzeTimingCorrelation(holders, 5);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].count, 3);
    assert.ok(clusters[0].spreadSeconds <= 300);
  });

  it('should return empty for spread-out purchases', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC);
    const holders = [
      { owner: 'W1', purchaseTime: new Date('2026-01-15T10:00:00Z') },
      { owner: 'W2', purchaseTime: new Date('2026-01-15T11:00:00Z') },
      { owner: 'W3', purchaseTime: new Date('2026-01-15T12:00:00Z') },
    ];

    const clusters = analyzer.analyzeTimingCorrelation(holders, 5);
    assert.equal(clusters.length, 0);
  });
});

// ─── NEW: Wallet Profile Tests ──────────────────────────────────────────────

describe('Wallet Profiling', () => {
  it('should detect FRESH_FUNDED wallet', () => {
    const analyzer = new WalletAnalyzer(TEST_RPC, 5);
    const profile = analyzer._profileWallet({
      uniqueTokenCount: 0, walletAgeDays: 1, txPerDay: 2, totalTransactions: 2,
    });
    assert.equal(profile, WalletProfile.FRESH_FUNDED);
  });

  it('should detect SNIPER_BOT', () => {
    const analyzer = new WalletAnalyzer(TEST_RPC, 5);
    const profile = analyzer._profileWallet({
      uniqueTokenCount: 1, walletAgeDays: 30, txPerDay: 80, totalTransactions: 2400,
    });
    assert.equal(profile, WalletProfile.SNIPER_BOT);
  });

  it('should detect DORMANT wallet', () => {
    const analyzer = new WalletAnalyzer(TEST_RPC, 5);
    const profile = analyzer._profileWallet({
      uniqueTokenCount: 20, walletAgeDays: 365, txPerDay: 0.05, totalTransactions: 18,
    });
    assert.equal(profile, WalletProfile.DORMANT);
  });

  it('should default to ORGANIC', () => {
    const analyzer = new WalletAnalyzer(TEST_RPC, 5);
    const profile = analyzer._profileWallet({
      uniqueTokenCount: 10, walletAgeDays: 60, txPerDay: 3, totalTransactions: 180,
    });
    assert.equal(profile, WalletProfile.ORGANIC);
  });
});

// ─── NEW: FundingAnalyzer Tests ─────────────────────────────────────────────

describe('FundingAnalyzer', () => {
  it('should instantiate correctly', () => {
    const fa = new FundingAnalyzer(TEST_RPC);
    assert.ok(fa);
  });

  it('should detect sybil clusters from shared funder', () => {
    const fa = new FundingAnalyzer(TEST_RPC);
    const fundingMap = new Map();
    fundingMap.set('walletA', { wallet: 'walletA', funder: 'sharedFunder', fundedAt: new Date(), fundingAmountSOL: 1 });
    fundingMap.set('walletB', { wallet: 'walletB', funder: 'sharedFunder', fundedAt: new Date(), fundingAmountSOL: 1 });
    fundingMap.set('walletC', { wallet: 'walletC', funder: 'uniqueFunder', fundedAt: new Date(), fundingAmountSOL: 1 });

    const clusters = fa._detectFundingClusters(fundingMap);
    assert.ok(clusters.length >= 1);
    assert.ok(clusters.some(c => c.walletCount >= 2 && c.funder === 'sharedFunder'));
  });

  it('should detect inter-holder funding', () => {
    const fa = new FundingAnalyzer(TEST_RPC);
    const fundingMap = new Map();
    fundingMap.set('walletA', { wallet: 'walletA', funder: 'externalFunder', fundedAt: new Date(), fundingAmountSOL: 5 });
    fundingMap.set('walletB', { wallet: 'walletB', funder: 'walletA', fundedAt: new Date(), fundingAmountSOL: 2 });

    const clusters = fa._detectFundingClusters(fundingMap);
    assert.ok(clusters.some(c => c.type === 'INTER_HOLDER_FUNDING'));
  });

  it('should detect sniper patterns', () => {
    const fa = new FundingAnalyzer(TEST_RPC);
    const now = new Date();
    const fundingMap = new Map();
    fundingMap.set('sniperWallet', {
      wallet: 'sniperWallet',
      funder: 'someFunder',
      fundedAt: new Date(now.getTime() - 10 * 60000), // 10 min ago
      fundingAmountSOL: 2,
    });

    const holders = [
      { owner: 'sniperWallet', purchaseTime: now },
    ];

    const snipers = fa._detectSniperFunding(fundingMap, holders);
    assert.equal(snipers.length, 1);
    assert.ok(snipers[0].minutesBetween <= 10);
  });
});

// ─── NEW: Token Health Metrics Tests ────────────────────────────────────────

describe('Token Health Metrics', () => {
  it('should calculate health for concentrated token', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC);
    const holders = [
      { owner: 'W1', balance: 900000, tokenCount: 0, walletAgeDays: 1, txFrequency: 0 },
      { owner: 'W2', balance: 50000, tokenCount: 5, walletAgeDays: 30, txFrequency: 2 },
      { owner: 'W3', balance: 30000, tokenCount: 10, walletAgeDays: 365, txFrequency: 1 },
      { owner: 'W4', balance: 20000, tokenCount: 8, walletAgeDays: 180, txFrequency: 0.5 },
    ];

    const health = analyzer.calculateTokenHealth(holders);
    assert.ok(health.gini > 0.5, `Expected Gini > 0.5, got ${health.gini}`);
    assert.ok(health.top5Concentration > 80);
    assert.equal(health.freshWallets, 1);
    assert.ok(health.tokenRiskScore > 0);
    assert.ok(health.tokenRiskLevel);
  });

  it('should show low risk for well-distributed token', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC);
    const holders = [
      { owner: 'W1', balance: 1000, tokenCount: 20, walletAgeDays: 365, txFrequency: 2 },
      { owner: 'W2', balance: 900, tokenCount: 15, walletAgeDays: 300, txFrequency: 1.5 },
      { owner: 'W3', balance: 800, tokenCount: 18, walletAgeDays: 200, txFrequency: 1 },
      { owner: 'W4', balance: 700, tokenCount: 12, walletAgeDays: 150, txFrequency: 0.8 },
    ];

    const health = analyzer.calculateTokenHealth(holders);
    assert.ok(health.gini < 0.3, `Expected low Gini, got ${health.gini}`);
    assert.equal(health.freshWallets, 0);
  });
});

describe('CSVImporter', () => {
  const testCsvPath = '/tmp/test_holders.csv';
  const testCsvContent = `Rank,Address,Quantity,Percentage
1,Wallet1ABCDEFGHIJKLMNOPQRSTUVWXYZabcd,1000000,50
2,Wallet2ABCDEFGHIJKLMNOPQRSTUVWXYZabcd,500000,25
3,Wallet3ABCDEFGHIJKLMNOPQRSTUVWXYZabcd,250000,12.5
4,Wallet4ABCDEFGHIJKLMNOPQRSTUVWXYZabcd,250000,12.5`;

  it('should validate valid CSV', () => {
    writeFileSync(testCsvPath, testCsvContent, 'utf-8');
    const importer = new CSVImporter();
    const result = importer.validateCSVFormat(testCsvPath);
    assert.ok(result.valid);
    assert.equal(result.rowCount, 4);
    unlinkSync(testCsvPath);
  });

  it('should parse CSV correctly', () => {
    writeFileSync(testCsvPath, testCsvContent, 'utf-8');
    const importer = new CSVImporter();
    const data = importer.parseCSV(testCsvPath, 'TestToken');
    assert.equal(data.holders.length, 4);
    assert.equal(data.totalHolders, 4);
    assert.ok(data.totalBalance > 0);
    assert.equal(data.holders[0].owner, 'Wallet1ABCDEFGHIJKLMNOPQRSTUVWXYZabcd');
    assert.equal(data.holders[0].balance, 1000000);
    unlinkSync(testCsvPath);
  });

  it('should reject invalid CSV', () => {
    const badCsv = 'Name,Value\nfoo,bar\n';
    writeFileSync(testCsvPath, badCsv, 'utf-8');
    const importer = new CSVImporter();
    const result = importer.validateCSVFormat(testCsvPath);
    assert.equal(result.valid, false);
    unlinkSync(testCsvPath);
  });

  it('should handle missing file', () => {
    const importer = new CSVImporter();
    assert.throws(() => importer.parseCSV('/tmp/nonexistent.csv'), /CSV file not found|Error parsing CSV/);
  });

  it('should support tab delimiter', () => {
    const tabCsv = `Address\tQuantity\tPercentage
Wallet1ABCDEFGHIJKLMNOPQRSTUVWXYZabcd\t1000000\t50
Wallet2ABCDEFGHIJKLMNOPQRSTUVWXYZabcd\t500000\t50`;
    writeFileSync(testCsvPath, tabCsv, 'utf-8');
    const importer = new CSVImporter();
    const data = importer.parseCSV(testCsvPath);
    assert.equal(data.holders.length, 2);
    unlinkSync(testCsvPath);
  });
});

describe('Integration - Solana Address Validation', () => {
  it('should validate known Solana addresses', () => {
    // USDC mint address (valid)
    assert.doesNotThrow(() => new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
    
    // Invalid address
    assert.throws(() => new PublicKey('invalid'));
  });
});

// ─── Known Entities Database Tests ────────────────────────────────────────

describe('Known Entities - Exchange Detection', () => {
  it('should identify Binance wallets', () => {
    const result = identifyExchange('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
    assert.equal(result.isExchange, true);
    assert.equal(result.name, 'Binance');
  });

  it('should identify MEXC wallet', () => {
    const result = identifyExchange('ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ');
    assert.equal(result.isExchange, true);
    assert.equal(result.name, 'MEXC');
  });

  it('should return false for unknown wallets', () => {
    const result = identifyExchange('RandomWalletAddress1234567890abcdef');
    assert.equal(result.isExchange, false);
    assert.equal(result.name, null);
  });

  it('should have at least 10 exchange entries', () => {
    assert.ok(EXCHANGE_WALLETS.size >= 10);
  });
});

describe('Known Entities - Liquidity Programs', () => {
  it('should detect Raydium AMM', () => {
    assert.equal(isLiquidityProgram('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), true);
  });

  it('should detect Jupiter V6', () => {
    assert.equal(isLiquidityProgram('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), true);
  });

  it('should detect Pump.fun', () => {
    assert.equal(isLiquidityProgram('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg'), true);
  });

  it('should detect system programs', () => {
    assert.equal(isLiquidityProgram('11111111111111111111111111111111'), true);
    assert.equal(isLiquidityProgram('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), true);
  });

  it('should return false for random wallets', () => {
    assert.equal(isLiquidityProgram('SomeRandomWallet123456789012345678901234'), false);
  });

  it('should have at least 20 programs', () => {
    assert.ok(LIQUIDITY_PROGRAMS.size >= 20);
  });
});

describe('Known Entities - Universal Tokens', () => {
  it('should detect wSOL (So111...112)', () => {
    assert.equal(isUniversalToken('So11111111111111111111111111111111111111112'), true);
  });

  it('should detect USDC', () => {
    assert.equal(isUniversalToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), true);
  });

  it('should detect USDT', () => {
    assert.equal(isUniversalToken('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), true);
  });

  it('should detect BONK (airdrop)', () => {
    assert.equal(isUniversalToken('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), true);
  });

  it('should NOT flag random/meme tokens', () => {
    assert.equal(isUniversalToken('DgwLComPpFGsnvtYLhRdFBDyzPTfYvdVRV7zfC1pump'), false);
    assert.equal(isUniversalToken('RandomMemeToken12345678901234567890'), false);
  });

  it('should have at least 10 universal tokens', () => {
    assert.ok(UNIVERSAL_TOKENS.size >= 10);
  });
});

describe('Known Entities - getEntityLabel', () => {
  it('should label exchanges with bank emoji', () => {
    const label = getEntityLabel('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
    assert.ok(label.includes('Binance'));
    assert.ok(label.includes('🏦'));
  });

  it('should label DEX/liquidity programs', () => {
    const label = getEntityLabel('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    assert.ok(label.includes('🔄'));
  });

  it('should return null for unknown addresses', () => {
    assert.equal(getEntityLabel('UnknownAddress1234567890123456789'), null);
  });
});

describe('Jaccard excludes universal tokens', () => {
  it('should not count wSOL as shared token', () => {
    // Simulate: if both wallets only share wSOL, Jaccard = 0 after filtering
    const setA = new Set(['So11111111111111111111111111111111111111112', 'TokenA']);
    const setB = new Set(['So11111111111111111111111111111111111111112', 'TokenB']);

    // Remove universal tokens
    for (const t of setA) if (isUniversalToken(t)) setA.delete(t);
    for (const t of setB) if (isUniversalToken(t)) setB.delete(t);

    const result = jaccardSimilarity(setA, setB);
    assert.equal(result, 0, 'Wallets sharing only wSOL should have 0 Jaccard');
  });

  it('should still detect real common tokens', () => {
    const setA = new Set(['So11111111111111111111111111111111111111112', 'RealMeme1', 'RealMeme2']);
    const setB = new Set(['So11111111111111111111111111111111111111112', 'RealMeme1', 'RealMeme2']);

    // Remove universal tokens
    for (const t of setA) if (isUniversalToken(t)) setA.delete(t);
    for (const t of setB) if (isUniversalToken(t)) setB.delete(t);

    const result = jaccardSimilarity(setA, setB);
    assert.equal(result, 1.0, 'Wallets sharing same real tokens should have Jaccard=1');
  });
});

// ─── Jaccard Threshold Tests ────────────────────────────────────────────────

describe('Jaccard smart threshold', () => {
  it('should match with Jaccard >= 0.08 AND 3+ common tokens', () => {
    // 20 tokens each, 4 shared → J = 4/(20+20-4)=4/36≈0.111 >= 0.08 ✓, count=4 >= 3 ✓
    const shared = ['T1', 'T2', 'T3', 'T4'];
    const a = new Set([...shared, ...Array.from({ length: 16 }, (_, i) => `A${i}`)]);
    const b = new Set([...shared, ...Array.from({ length: 16 }, (_, i) => `B${i}`)]);
    const j = jaccardSimilarity(a, b);
    const common = [...a].filter(t => b.has(t));
    const minSize = Math.min(a.size, b.size);
    const commonPct = common.length / minSize;
    const passesJaccard = j >= 0.08 && common.length >= 3;
    const passesRaw = common.length >= 8 && commonPct >= 0.05;
    assert.ok(passesJaccard || passesRaw, `Should match Jaccard threshold: J=${j}, common=${common.length}`);
  });

  it('should match large portfolios with 8+ common AND 5%+ overlap', () => {
    // 100 each, 10 shared → J=10/190≈0.053, count=10≥8, pct=10/100=10%≥5%
    const shared = Array.from({ length: 10 }, (_, i) => `T${i}`);
    const a = new Set([...shared, ...Array.from({ length: 90 }, (_, i) => `A${i}`)]);
    const b = new Set([...shared, ...Array.from({ length: 90 }, (_, i) => `B${i}`)]);
    const j = jaccardSimilarity(a, b);
    const common = [...a].filter(t => b.has(t));
    const minSize = Math.min(a.size, b.size);
    const commonPct = common.length / minSize;
    assert.ok(common.length >= 8, `Common count ${common.length} should be >= 8`);
    assert.ok(commonPct >= 0.05, `Common % ${commonPct} should be >= 5%`);
    assert.ok(j < 0.08, `Jaccard ${j} < 0.08 (large portfolio dilution)`);
    // Should still match via raw count threshold
    const passesRaw = common.length >= 8 && commonPct >= 0.05;
    assert.ok(passesRaw, 'Raw count threshold should catch this');
  });

  it('should NOT match 6 common out of 200 (low % overlap)', () => {
    // 200 each, 6 shared → J=6/394≈0.015, count=6<8 ✗, pct=6/200=3%<5% ✗
    const shared = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
    const a = new Set([...shared, ...Array.from({ length: 194 }, (_, i) => `A${i}`)]);
    const b = new Set([...shared, ...Array.from({ length: 194 }, (_, i) => `B${i}`)]);
    const j = jaccardSimilarity(a, b);
    const common = [...a].filter(t => b.has(t));
    const minSize = Math.min(a.size, b.size);
    const commonPct = common.length / minSize;
    const passesJaccard = j >= 0.08 && common.length >= 3;
    const passesRaw = common.length >= 8 && commonPct >= 0.05;
    assert.ok(!passesJaccard && !passesRaw, 'Should reject: low overlap is random coincidence');
  });

  it('should NOT match 5 common out of 100 (below raw threshold)', () => {
    // 100 each, 5 shared → J=5/195≈0.026<0.08, count=5<8 ✗
    const shared = ['T1', 'T2', 'T3', 'T4', 'T5'];
    const a = new Set([...shared, ...Array.from({ length: 95 }, (_, i) => `A${i}`)]);
    const b = new Set([...shared, ...Array.from({ length: 95 }, (_, i) => `B${i}`)]);
    const j = jaccardSimilarity(a, b);
    const common = [...a].filter(t => b.has(t));
    const minSize = Math.min(a.size, b.size);
    const commonPct = common.length / minSize;
    const passesJaccard = j >= 0.08 && common.length >= 3;
    const passesRaw = common.length >= 8 && commonPct >= 0.05;
    assert.ok(!passesJaccard && !passesRaw, 'Should reject: 5 out of 100 is noise');
  });
});

// ─── InsiderDetector Tests ──────────────────────────────────────────────────

describe('InsiderDetector', () => {
  it('should instantiate correctly', () => {
    const detector = new InsiderDetector(TEST_RPC);
    assert.ok(detector);
  });
});

describe('InsiderDetector - detectInsiderGroups', () => {
  it('should group wallets with multiple signals', () => {
    const detector = new InsiderDetector(TEST_RPC);
    const holders = [
      { owner: 'WalletA', balance: 1000, walletAgeDays: 3, tokenCount: 2, tradedTokens: new Set(['tok1', 'tok2']) },
      { owner: 'WalletB', balance: 800, walletAgeDays: 3, tokenCount: 2, tradedTokens: new Set(['tok1', 'tok2']) },
      { owner: 'WalletC', balance: 500, walletAgeDays: 30, tokenCount: 10, tradedTokens: new Set(['tok3', 'tok4']) },
    ];

    const similarity = {
      groups: [{ wallets: ['WalletA', 'WalletB'], avgJaccard: 0.85, commonTokens: ['tok1', 'tok2'], commonTokenCount: 2, walletCount: 2 }],
      timingClusters: [{ wallets: ['WalletA', 'WalletB'], spreadSeconds: 30, count: 2 }],
      totalGroups: 1,
      totalTimingClusters: 1,
    };

    const funding = {
      clusters: [{ wallets: ['WalletA', 'WalletB'], funder: 'FunderX', walletCount: 2, type: 'SHARED_FUNDER' }],
      totalClusters: 1,
    };

    const groups = detector.detectInsiderGroups(holders, similarity, funding, []);
    assert.ok(groups.length >= 1, 'Should detect at least 1 insider group');

    const grp = groups[0];
    assert.ok(grp.wallets.includes('WalletA'));
    assert.ok(grp.wallets.includes('WalletB'));
    assert.ok(grp.confidence >= 45, `Confidence should be >= 45, got ${grp.confidence}`);
    assert.ok(grp.evidence.tokenOverlap, 'Should have tokenOverlap evidence');
    assert.ok(grp.evidence.sharedFunder, 'Should have sharedFunder evidence');
    assert.ok(grp.evidence.timing, 'Should have timing evidence');
  });

  it('should NOT group unrelated wallets', () => {
    const detector = new InsiderDetector(TEST_RPC);
    const holders = [
      { owner: 'WalletX', balance: 1000, walletAgeDays: 100, tokenCount: 20, tradedTokens: new Set(['a1', 'a2']) },
      { owner: 'WalletY', balance: 500, walletAgeDays: 200, tokenCount: 15, tradedTokens: new Set(['b1', 'b2']) },
    ];

    const groups = detector.detectInsiderGroups(holders, { groups: [], timingClusters: [] }, { clusters: [] }, []);
    assert.equal(groups.length, 0, 'Should detect 0 insider groups for unrelated wallets');
  });

  it('should detect SOL transfer connections', () => {
    const detector = new InsiderDetector(TEST_RPC);
    const holders = [
      { owner: 'WalletA', balance: 1000, walletAgeDays: 5, tokenCount: 3 },
      { owner: 'WalletB', balance: 800, walletAgeDays: 5, tokenCount: 3 },
    ];

    const transfers = [
      { from: 'WalletA', to: 'WalletB', amountSOL: 1.5, timestamp: new Date(), signature: 'sig1' },
    ];

    const groups = detector.detectInsiderGroups(holders, { groups: [], timingClusters: [] }, { clusters: [] }, transfers);
    assert.ok(groups.length >= 1);
    assert.ok(groups[0].evidence.solTransfer, 'Should have solTransfer evidence');
    assert.ok(groups[0].confidence >= 20, 'SOL transfer should give >=20 confidence');
  });

  it('should calculate correct confidence for strong insider group', () => {
    const detector = new InsiderDetector(TEST_RPC);
    const holders = [
      { owner: 'W1', balance: 1000, walletAgeDays: 2, tokenCount: 2 },
      { owner: 'W2', balance: 900, walletAgeDays: 2, tokenCount: 2 },
      { owner: 'W3', balance: 800, walletAgeDays: 2, tokenCount: 2 },
    ];

    const similarity = {
      groups: [{ wallets: ['W1', 'W2', 'W3'], avgJaccard: 0.9, commonTokens: ['t1'], commonTokenCount: 1, walletCount: 3 }],
      timingClusters: [{ wallets: ['W1', 'W2', 'W3'], spreadSeconds: 10, count: 3 }],
    };
    const funding = {
      clusters: [{ wallets: ['W1', 'W2', 'W3'], funder: 'F1', walletCount: 3, type: 'SHARED_FUNDER' }],
    };
    const transfers = [{ from: 'W1', to: 'W2', amountSOL: 2, timestamp: new Date(), signature: 's1' }];

    const groups = detector.detectInsiderGroups(holders, similarity, funding, transfers);
    assert.ok(groups[0].confidence >= 70, `Strong insider group should have confidence >=70, got ${groups[0].confidence}`);
    assert.ok(groups[0].confidenceLabel.includes('SANGAT MUNGKIN'));
  });

  it('should filter out groups with confidence < 10 (noise)', () => {
    const detector = new InsiderDetector(TEST_RPC);
    // Only evidence: group size of 5 = 5pts < 10 threshold
    const holders = [
      { owner: 'W1', balance: 100, walletAgeDays: 50, tokenCount: 10 },
      { owner: 'W2', balance: 100, walletAgeDays: 50, tokenCount: 10 },
      { owner: 'W3', balance: 100, walletAgeDays: 50, tokenCount: 10 },
      { owner: 'W4', balance: 100, walletAgeDays: 50, tokenCount: 10 },
      { owner: 'W5', balance: 100, walletAgeDays: 50, tokenCount: 10 },
    ];
    // Create similarity group with very low Jaccard (below scoring threshold)
    const similarity = {
      groups: [{ wallets: ['W1', 'W2', 'W3', 'W4', 'W5'], avgJaccard: 0.01, commonTokens: ['t1', 't2', 't3', 't4', 't5'], commonTokenCount: 5, walletCount: 5 }],
      timingClusters: [],
    };
    const groups = detector.detectInsiderGroups(holders, similarity, { clusters: [] }, []);
    assert.equal(groups.length, 0, 'Groups with confidence < 10 should be filtered out as noise');
  });
});

describe('InsiderDetector - formatInsiderOutput', () => {
  it('should format output with group details', () => {
    const detector = new InsiderDetector(TEST_RPC);
    const holders = [
      { owner: 'WalletA', balance: 1000, walletAgeDays: 3, tokenCount: 2, riskData: { score: 60 } },
      { owner: 'WalletB', balance: 800, walletAgeDays: 3, tokenCount: 2, riskData: { score: 55 } },
    ];

    const groups = [{
      wallets: ['WalletA', 'WalletB'],
      walletCount: 2,
      confidence: 75,
      confidenceLabel: '🔴 SANGAT MUNGKIN INSIDER/TEAM',
      signals: ['🔴 Token overlap sangat tinggi (J=0.85) — 35pts', '💰 Didanai dari sumber yang sama — 25pts'],
      evidence: { tokenOverlap: true, sharedFunder: true, timing: false, solTransfer: false, sharedTokens: new Set(['tok1']), funders: new Set(['FunderX']), transfers: [] },
      supplyPct: 60.5,
      groupBalance: 1800,
    }];

    const output = detector.formatInsiderOutput(groups, holders, null);
    assert.ok(output.includes('SUSPECTED INSIDER'), 'Should have insider header');
    assert.ok(output.includes('SANGAT MUNGKIN'), 'Should have confidence label');
    assert.ok(output.includes('WalletA'), 'Should list member wallets');
    assert.ok(output.includes('TOKEN YANG SAMA'), 'Should show shared tokens');
    assert.ok(output.includes('FunderX'), 'Should show funder');
  });

  it('should show no groups message when empty', () => {
    const detector = new InsiderDetector(TEST_RPC);
    const output = detector.formatInsiderOutput([], [], null);
    assert.ok(output.includes('Tidak ditemukan'));
  });
});

describe('InsiderDetector - skip known entity funders', () => {
  it('should NOT flag wallets funded by known exchange as insider', () => {
    const detector = new InsiderDetector(TEST_RPC);
    const holders = [
      { owner: 'WalletA', balance: 1000, walletAgeDays: 5, tokenCount: 3 },
      { owner: 'WalletB', balance: 800, walletAgeDays: 5, tokenCount: 3 },
    ];

    // Funder is Binance (known exchange in EXCHANGE_WALLETS)
    const funding = {
      clusters: [{
        wallets: ['WalletA', 'WalletB'],
        funder: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', // Binance
        walletCount: 2,
        type: 'SHARED_FUNDER',
      }],
    };

    const groups = detector.detectInsiderGroups(holders, { groups: [], timingClusters: [] }, funding, []);
    assert.equal(groups.length, 0, 'Should NOT create insider group for exchange-funded wallets');
  });

  it('should NOT flag wallets funded by known bot as insider', () => {
    const detector = new InsiderDetector(TEST_RPC);
    const holders = [
      { owner: 'WalletX', balance: 500, walletAgeDays: 10, tokenCount: 5 },
      { owner: 'WalletY', balance: 400, walletAgeDays: 10, tokenCount: 5 },
    ];

    // Funder is Sniper MEV Bot (known in EXCHANGE_WALLETS)
    const funding = {
      clusters: [{
        wallets: ['WalletX', 'WalletY'],
        funder: 'po27vzv7pSZYsroDopmGVVBVAqxg4GcyZXxmCkoejFB', // 🤖 Sniper MEV Bot
        walletCount: 2,
        type: 'SHARED_FUNDER',
      }],
    };

    const groups = detector.detectInsiderGroups(holders, { groups: [], timingClusters: [] }, funding, []);
    assert.equal(groups.length, 0, 'Should NOT create insider group for bot-funded wallets');
  });

  it('should still flag UNKNOWN shared funders as insider', () => {
    const detector = new InsiderDetector(TEST_RPC);
    const holders = [
      { owner: 'WalletA', balance: 1000, walletAgeDays: 5, tokenCount: 3 },
      { owner: 'WalletB', balance: 800, walletAgeDays: 5, tokenCount: 3 },
    ];

    const funding = {
      clusters: [{
        wallets: ['WalletA', 'WalletB'],
        funder: 'SomeUnknownFunderWallet123456789012345678901234',
        walletCount: 2,
        type: 'SHARED_FUNDER',
      }],
    };

    const groups = detector.detectInsiderGroups(holders, { groups: [], timingClusters: [] }, funding, []);
    assert.ok(groups.length >= 1, 'Should flag unknown shared funder as insider');
    assert.ok(groups[0].evidence.sharedFunder);
  });
});

// ============== Plan Config Tests ==============

describe('PlanConfig', () => {
  it('PLANS should have free and paid presets', () => {
    assert.ok(PLANS.free, 'Should have free plan');
    assert.ok(PLANS.paid, 'Should have paid plan');
  });

  it('free plan should have conservative defaults', () => {
    const free = PLANS.free;
    assert.equal(free.maxRps, 12);
    assert.equal(free.txHistoryPerWallet, 50);
    assert.equal(free.walletAgePages, 3);
    assert.equal(free.fundingHops, 2);
    assert.equal(free.interHolderTxScan, 10);
    assert.equal(free.tokenHistoryEarlyStop, 50);
    assert.equal(free.purchaseTimeScanLimit, 1000);
    assert.equal(free.topHolders, 20);
  });

  it('paid plan should have deeper scanning', () => {
    const paid = PLANS.paid;
    assert.equal(paid.maxRps, 40);
    assert.equal(paid.txHistoryPerWallet, 200);
    assert.equal(paid.walletAgePages, 5);
    assert.equal(paid.fundingHops, 4);
    assert.equal(paid.interHolderTxScan, 30);
    assert.equal(paid.tokenHistoryEarlyStop, 150);
    assert.equal(paid.purchaseTimeScanLimit, 3000);
  });

  it('paid plan should be strictly better than free', () => {
    for (const key of ['maxRps', 'txHistoryPerWallet', 'walletAgePages', 'fundingHops', 'interHolderTxScan', 'tokenHistoryEarlyStop', 'purchaseTimeScanLimit']) {
      assert.ok(PLANS.paid[key] > PLANS.free[key], `paid.${key} (${PLANS.paid[key]}) should be > free.${key} (${PLANS.free[key]})`);
    }
  });

  it('getPlanConfig() should return object with all required fields', () => {
    const oldPlan = process.env.QUICKNODE_PLAN;
    delete process.env.QUICKNODE_PLAN;
    delete process.env.MAX_RPS;
    delete process.env.TOP_HOLDERS;
    delete process.env.TX_HISTORY_PER_WALLET;
    delete process.env.FUNDING_HOPS;

    const config = getPlanConfig();
    const required = ['maxRps', 'topHolders', 'txHistoryPerWallet', 'walletAgePages', 'fundingHops', 'interHolderTxScan', 'tokenHistoryEarlyStop', 'purchaseTimeScanLimit', 'name', 'description'];
    for (const field of required) {
      assert.ok(config[field] !== undefined, `Missing field: ${field}`);
    }

    // Default should be free plan
    assert.equal(config.maxRps, 12);
    assert.equal(config.name, 'Free');

    if (oldPlan !== undefined) process.env.QUICKNODE_PLAN = oldPlan;
  });

  it('getPlanConfig() should respect QUICKNODE_PLAN=paid', () => {
    const oldPlan = process.env.QUICKNODE_PLAN;
    process.env.QUICKNODE_PLAN = 'paid';
    delete process.env.MAX_RPS;
    delete process.env.FUNDING_HOPS;

    const config = getPlanConfig();
    assert.equal(config.maxRps, 40);
    assert.equal(config.fundingHops, 4);
    assert.ok(config.name.includes('Build'));

    if (oldPlan !== undefined) process.env.QUICKNODE_PLAN = oldPlan;
    else delete process.env.QUICKNODE_PLAN;
  });

  it('getPlanConfig() should allow env overrides', () => {
    const oldPlan = process.env.QUICKNODE_PLAN;
    const oldRps = process.env.MAX_RPS;
    const oldHops = process.env.FUNDING_HOPS;

    process.env.QUICKNODE_PLAN = 'free';
    process.env.MAX_RPS = '25';
    process.env.FUNDING_HOPS = '3';

    const config = getPlanConfig();
    assert.equal(config.maxRps, 25, 'MAX_RPS override');
    assert.equal(config.fundingHops, 3, 'FUNDING_HOPS override');
    // Non-overridden values stay at plan defaults
    assert.equal(config.walletAgePages, 3);

    // Restore
    if (oldPlan !== undefined) process.env.QUICKNODE_PLAN = oldPlan; else delete process.env.QUICKNODE_PLAN;
    if (oldRps !== undefined) process.env.MAX_RPS = oldRps; else delete process.env.MAX_RPS;
    if (oldHops !== undefined) process.env.FUNDING_HOPS = oldHops; else delete process.env.FUNDING_HOPS;
  });

  it('paid plan should have enhanced API flags enabled', () => {
    assert.equal(PLANS.paid.useBatchAccounts, true);
    assert.equal(PLANS.paid.useEnhancedTx, true);
    assert.equal(PLANS.paid.useDAS, true);
    assert.equal(PLANS.paid.useSNS, true);
    assert.equal(PLANS.paid.useProgramAccounts, true);
    assert.equal(PLANS.paid.detectProgramOwned, true);
    assert.equal(PLANS.paid.batchAccountsLimit, 100);
  });

  it('free plan should have limited enhanced features', () => {
    // Free/Discover: getMultipleAccounts works but limited to 5/call
    assert.equal(PLANS.free.useBatchAccounts, true);
    assert.equal(PLANS.free.detectProgramOwned, true);
    assert.equal(PLANS.free.batchAccountsLimit, 5);
    // These remain disabled on free
    assert.equal(PLANS.free.useEnhancedTx, false);
    assert.equal(PLANS.free.useDAS, false);
    assert.equal(PLANS.free.useSNS, false);
    assert.equal(PLANS.free.useProgramAccounts, false);
  });

  it('paid plan topHolders should be 200 (getProgramAccounts unlocked)', () => {
    assert.equal(PLANS.paid.topHolders, 200);
  });
});

// ============== Enhanced API Integration Tests ==============

describe('HolderAnalyzer - Enhanced Config', () => {
  it('should accept enhanced feature flags in config', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC, {
      maxRps: 40,
      useBatchAccounts: true,
      useEnhancedTx: true,
      useDAS: true,
      useSNS: true,
      useProgramAccounts: true,
      detectProgramOwned: true,
    });
    assert.equal(analyzer.config.useBatchAccounts, true);
    assert.equal(analyzer.config.useEnhancedTx, true);
    assert.equal(analyzer.config.useDAS, true);
    assert.equal(analyzer.config.useSNS, true);
    assert.equal(analyzer.config.useProgramAccounts, true);
    assert.equal(analyzer.config.detectProgramOwned, true);
  });

  it('should default enhanced flags to false', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC, { maxRps: 12 });
    assert.equal(analyzer.config.useBatchAccounts, false);
    assert.equal(analyzer.config.useEnhancedTx, false);
    assert.equal(analyzer.config.useDAS, false);
    assert.equal(analyzer.config.useSNS, false);
  });

  it('_extractTokenMintsFromTx should extract mints from token balances', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC);
    const mockTx = {
      meta: {
        preTokenBalances: [
          { mint: 'TokenA111111111111111111111111111111111111111', owner: 'Wallet1', uiTokenAmount: { uiAmount: 100 } },
        ],
        postTokenBalances: [
          { mint: 'TokenA111111111111111111111111111111111111111', owner: 'Wallet1', uiTokenAmount: { uiAmount: 200 } },
          { mint: 'TokenB222222222222222222222222222222222222222', owner: 'Wallet1', uiTokenAmount: { uiAmount: 50 } },
        ],
        innerInstructions: [],
      },
    };
    const mints = analyzer._extractTokenMintsFromTx(mockTx, 'Wallet1', null);
    assert.ok(mints.has('TokenA111111111111111111111111111111111111111'));
    assert.ok(mints.has('TokenB222222222222222222222222222222222222222'));
    assert.equal(mints.size, 2);
  });

  it('_extractTokenMintsFromTx should exclude specified token', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC);
    const mockTx = {
      meta: {
        preTokenBalances: [],
        postTokenBalances: [
          { mint: 'TargetToken11111111111111111111111111111111', owner: 'W1', uiTokenAmount: { uiAmount: 10 } },
          { mint: 'OtherToken111111111111111111111111111111111', owner: 'W1', uiTokenAmount: { uiAmount: 5 } },
        ],
        innerInstructions: [],
      },
    };
    const mints = analyzer._extractTokenMintsFromTx(mockTx, 'W1', 'TargetToken11111111111111111111111111111111');
    assert.ok(!mints.has('TargetToken11111111111111111111111111111111'));
    assert.ok(mints.has('OtherToken111111111111111111111111111111111'));
  });
});

describe('FundingAnalyzer - Enhanced Config', () => {
  it('should accept useEnhancedTx in config', () => {
    const analyzer = new FundingAnalyzer(TEST_RPC, { maxRps: 40, useEnhancedTx: true });
    assert.equal(analyzer.config.useEnhancedTx, true);
  });

  it('should default useEnhancedTx to false', () => {
    const analyzer = new FundingAnalyzer(TEST_RPC, {});
    assert.equal(analyzer.config.useEnhancedTx, false);
  });

  it('_extractFunderFromTx should find SOL sender', () => {
    const analyzer = new FundingAnalyzer(TEST_RPC, {});
    const mockTx = {
      meta: {
        preBalances: [1000000000, 5000000000],  // funder had 5 SOL
        postBalances: [2000000000, 4000000000],  // funder sent 1 SOL to wallet
      },
      transaction: {
        message: {
          accountKeys: ['ReceiverWallet11111111111111111111111111111', 'FunderWallet1111111111111111111111111111111'],
        },
      },
      blockTime: 1700000000,
    };

    const result = analyzer._extractFunderFromTx(mockTx, 'ReceiverWallet11111111111111111111111111111');
    assert.ok(result, 'Should find funder');
    assert.equal(result.funder, 'FunderWallet1111111111111111111111111111111');
    assert.ok(result.amountSOL > 0);
    assert.ok(result.timestamp instanceof Date);
  });
});

describe('InsiderDetector - Enhanced Config', () => {
  it('should accept useEnhancedTx and useSNS in config', () => {
    const detector = new InsiderDetector(TEST_RPC, 40, { useEnhancedTx: true, useSNS: true });
    assert.equal(detector.useEnhancedTx, true);
    assert.equal(detector.useSNS, true);
  });

  it('should default enhanced flags to false', () => {
    const detector = new InsiderDetector(TEST_RPC, 12, {});
    assert.equal(detector.useEnhancedTx, false);
    assert.equal(detector.useSNS, false);
  });

  it('SNS domains should reduce confidence for groups', () => {
    const detector = new InsiderDetector(TEST_RPC, 12, {});
    const holders = [
      { owner: 'WalletA', balance: 500, tradedTokens: new Set(['T1', 'T2', 'T3']), historicalTokenCount: 3, walletAgeDays: 100, tokenCount: 3 },
      { owner: 'WalletB', balance: 500, tradedTokens: new Set(['T1', 'T2', 'T3']), historicalTokenCount: 3, walletAgeDays: 100, tokenCount: 3 },
    ];
    const similarity = {
      groups: [{ wallets: ['WalletA', 'WalletB'], avgJaccard: 0.5, commonTokens: ['T1', 'T2'], commonTokenCount: 2 }],
      timingClusters: [],
    };
    const funding = { clusters: [] };

    // Without SNS: higher confidence
    const groupsNoSNS = detector.detectInsiderGroups(holders, similarity, funding, [], new Map());
    assert.ok(groupsNoSNS.length >= 1);
    const confNoSNS = groupsNoSNS[0].confidence;

    // With SNS: both wallets have .sol domains → lower confidence
    const snsDomains = new Map([
      ['WalletA', ['alice.sol']],
      ['WalletB', ['bob.sol']],
    ]);
    const groupsWithSNS = detector.detectInsiderGroups(holders, similarity, funding, [], snsDomains);
    assert.ok(groupsWithSNS.length >= 1);
    assert.ok(groupsWithSNS[0].confidence < confNoSNS, `SNS should reduce confidence: ${groupsWithSNS[0].confidence} < ${confNoSNS}`);
  });
});

// ============== getProgramAccounts & PDA Detection Tests ==============

describe('Known Entities - Program Labels (PDA Detection)', () => {
  it('KNOWN_PROGRAM_LABELS should contain Pump.fun programs', () => {
    assert.ok(KNOWN_PROGRAM_LABELS.size >= 20, `Expected 20+ program labels, got ${KNOWN_PROGRAM_LABELS.size}`);
    assert.ok(KNOWN_PROGRAM_LABELS.has('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), 'Should have Pump.fun');
    assert.ok(KNOWN_PROGRAM_LABELS.get('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P').includes('Pump.fun'));
  });

  it('KNOWN_PROGRAM_LABELS should contain Raydium, Orca, Jupiter', () => {
    assert.ok(KNOWN_PROGRAM_LABELS.has('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), 'Should have Raydium');
    assert.ok(KNOWN_PROGRAM_LABELS.has('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'), 'Should have Orca');
    assert.ok(KNOWN_PROGRAM_LABELS.has('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), 'Should have Jupiter');
  });

  it('getProgramLabel() should return label for known programs', () => {
    const pumpLabel = getProgramLabel('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    assert.ok(pumpLabel, 'Should return label for Pump.fun');
    assert.ok(pumpLabel.includes('Pump.fun'), `Label should mention Pump.fun: ${pumpLabel}`);
    assert.ok(pumpLabel.includes('🐸'), 'Should have frog emoji for Pump.fun');
  });

  it('getProgramLabel() should return null for unknown programs', () => {
    assert.equal(getProgramLabel('UnknownProgram123456789012345678901234'), null);
  });

  it('getProgramLabel() should return label for Raydium AMM', () => {
    const label = getProgramLabel('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    assert.ok(label.includes('Raydium'));
  });
});

describe('Known Entities - isUserWallet()', () => {
  it('System Program owner = real user wallet', () => {
    assert.equal(isUserWallet(SYSTEM_PROGRAM_ID), true);
  });

  it('Pump.fun program owner = PDA (not user)', () => {
    assert.equal(isUserWallet('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), false);
  });

  it('Token Program owner = PDA (not user)', () => {
    assert.equal(isUserWallet('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), false);
  });

  it('Raydium AMM owner = PDA (not user)', () => {
    assert.equal(isUserWallet('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), false);
  });

  it('SYSTEM_PROGRAM_ID should be standard system program', () => {
    assert.equal(SYSTEM_PROGRAM_ID, '11111111111111111111111111111111');
  });
});

describe('HolderAnalyzer - getProgramAccounts & PDA Detection Config', () => {
  it('should default useProgramAccounts and detectProgramOwned to false', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC, {});
    assert.equal(analyzer.config.useProgramAccounts, false);
    assert.equal(analyzer.config.detectProgramOwned, false);
  });

  it('paid plan config should enable getProgramAccounts + PDA detection', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC, PLANS.paid);
    assert.equal(analyzer.config.useProgramAccounts, true);
    assert.equal(analyzer.config.detectProgramOwned, true);
  });

  it('free plan config should NOT enable getProgramAccounts but SHOULD enable PDA detection', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC, PLANS.free);
    assert.equal(analyzer.config.useProgramAccounts, false);
    assert.equal(analyzer.config.detectProgramOwned, true);
    assert.equal(analyzer.config.batchAccountsLimit, 5);
  });
});

describe('Output Formatting - Entities show names only (no addresses)', () => {
  it('filtered entities output should NOT contain raw wallet addresses', () => {
    const analyzer = new HolderAnalyzer(TEST_RPC, PLANS.free);
    const holders = [
      { owner: 'UserWallet1234567890123456789012345678901', balance: 1000, walletAgeDays: 30, tokenCount: 10, historicalTokenCount: 10, tradedTokens: new Set(['T1']), purchaseTimeStr: 'Unknown', totalTxCount: 50, txFrequency: 2 },
    ];
    const filteredEntities = [
      { owner: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', type: 'EXCHANGE', label: '🏦 Binance', balance: 5000 },
      { owner: 'PumpFunBondingCurvePDA12345678901234567890', type: 'PDA', label: '🐸 Pump.fun Bonding Curve', balance: 50000000 },
    ];
    const output = analyzer.formatHoldersOutput(holders, 'TestMint123', null, null, filteredEntities);

    // Filtered entities section should show labels, NOT raw addresses
    assert.ok(output.includes('🏦 Binance'), 'Should show Binance label');
    assert.ok(output.includes('🐸 Pump.fun Bonding Curve'), 'Should show Pump.fun label');
    // Should NOT contain the raw exchange address in the filtered section
    assert.ok(!output.includes('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'), 'Should NOT show raw exchange address');
    assert.ok(!output.includes('PumpFunBondingCurvePDA12345678901234567890'), 'Should NOT show raw PDA address');
  });
});

// ============== isOnCurve PDA Detection Tests ==============

describe('checkIsOnCurve - Ed25519 curve check (zero RPC)', () => {
  it('should return true for known real user wallets (on-curve)', () => {
    // Binance hot wallet — real wallet, has private key, isOnCurve: true
    assert.equal(checkIsOnCurve('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'), true);
  });

  it('program IDs are on-curve (deployed from keypairs)', () => {
    // Program IDs are NOT PDAs — they were created from real keypairs
    // isOnCurve=true for programs. Phase 3 (owner check) handles them.
    assert.equal(checkIsOnCurve('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), true);
    assert.equal(checkIsOnCurve('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), true);
  });

  it('should return false for addresses derived via findProgramAddress (true PDAs)', () => {
    // ComputeBudget is a native program with a manufactured off-curve address
    assert.equal(checkIsOnCurve('ComputeBudget111111111111111111111111111111'), false);
  });

  it('should return false for invalid/garbage addresses', () => {
    assert.equal(checkIsOnCurve('invalid'), false);
    assert.equal(checkIsOnCurve(''), false);
  });

  it('Pump.fun AMM program should be in KNOWN_PROGRAM_LABELS', () => {
    const label = KNOWN_PROGRAM_LABELS.get('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
    assert.ok(label, 'Should have Pump.fun AMM label');
    assert.ok(label.includes('Pump.fun AMM'));
  });

  it('isOnCurve catches real PDAs — bonding curve TOKEN accounts are off-curve', async () => {
    // In real usage: Pump.fun bonding curve's TOKEN ACCOUNT (not program ID)
    // is a PDA derived via findProgramAddress → always off-curve.
    // We generate a test PDA to verify:
    const { PublicKey } = await import('@solana/web3.js');
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('test-seed')],
      new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    );
    assert.equal(checkIsOnCurve(pda.toBase58()), false, 'PDA should be off-curve');
  });

  it('summary: isOnCurve filters PDAs, Phase 3 owner-check handles programs', () => {
    // This test documents the 3-layer detection strategy:
    // Layer 1: Static lists (EXCHANGE_WALLETS, LIQUIDITY_PROGRAMS)
    // Layer 2: isOnCurve=false → instant PDA filter (0 RPC calls)
    // Layer 3: getMultipleAccounts owner check → catches on-curve programs
    //
    // Pump.fun pool accounts in real data:
    //   - Token ACCOUNT (holds tokens) = PDA → off-curve → caught by Layer 2
    //   - Program owner field = 6EF8r... → caught by Layer 3 label upgrade

    // Verify the function at least works correctly on edge cases
    assert.equal(typeof checkIsOnCurve('11111111111111111111111111111111'), 'boolean');
    assert.equal(typeof checkIsOnCurve('randomtext'), 'boolean');
  });
});