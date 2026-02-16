#!/usr/bin/env node

/**
 * Solana Wallet Checker Bot - Main Entry Point (Node.js version)
 * 
 * A real-time Solana token transaction monitor that classifies wallets as:
 * - FRESH: No other token transactions except current purchase
 * - SEMI_NEW: Less than 5 different token transactions
 * - OLD: 5 or more different token transactions
 * 
 * Usage: node src/main.js
 * 
 * Environment Variables (set in .env file):
 *   SOLANA_RPC_URL: Solana RPC endpoint
 *   SOLANA_WSS_URL: Solana WebSocket endpoint
 *   OLD_WALLET_THRESHOLD: Number of tokens to classify as OLD (default: 5)
 *   POLL_INTERVAL: Polling interval in seconds (default: 5)
 */

import 'dotenv/config';
import { createInterface } from 'readline';
import { writeFileSync } from 'fs';
import { PublicKey } from '@solana/web3.js';
import chalk from 'chalk';
import { WalletAnalyzer, WalletType, WalletProfile } from './walletAnalyzer.js';
import { TransactionMonitor } from './transactionMonitor.js';
import { HolderAnalyzer } from './holderAnalyzer.js';
import { FundingAnalyzer } from './fundingAnalyzer.js';
import { InsiderDetector } from './insiderDetector.js';
import { CSVImporter } from './csvImporter.js';
import { getPlanConfig } from './planConfig.js';
import { getCurrentPrice, analyzeEarlyBuyers, formatPnLOutput } from './priceAnalyzer.js';
import { APP_VERSION, sleep } from './utils.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(question) {
  return new Promise((resolve) => {
    const r = rl();
    r.question(question, (answer) => {
      r.close();
      resolve(answer.trim());
    });
  });
}

function timestamp() {
  return new Date().toTimeString().split(' ')[0];
}

function formatDate(date) {
  if (!date) return 'Unknown';
  return date.toISOString().replace('T', ' ').split('.')[0];
}

function truncateAddress(addr) {
  if (!addr) return 'Unknown';
  return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
}

function validateSolanaAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * RPC health check — verify the RPC endpoint is reachable before starting.
 * Calls getSlot() as a lightweight ping. Retries up to 3 times on 429.
 */
async function checkRpcHealth(rpcUrl) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.status === 429) {
        const wait = 1000 * attempt;
        console.log(chalk.yellow(`  ⏳ Rate limited (429), retry ${attempt}/3 dalam ${wait}ms...`));
        await sleep(wait);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.error) {
        if (data.error.code === 429 || String(data.error.message).includes('429')) {
          const wait = 1000 * attempt;
          console.log(chalk.yellow(`  ⏳ Rate limited, retry ${attempt}/3 dalam ${wait}ms...`));
          await sleep(wait);
          continue;
        }
        throw new Error(data.error.message || JSON.stringify(data.error));
      }
      console.log(chalk.green(`  ✅ RPC OK — slot ${data.result}`));
      return true;
    } catch (err) {
      if (attempt < 3 && err.message?.includes('429')) {
        await sleep(1000 * attempt);
        continue;
      }
      console.log(chalk.red(`  ❌ RPC health check gagal: ${err.message}`));
      console.log(chalk.yellow('  Pastikan SOLANA_RPC_URL di .env benar dan endpoint aktif.'));
      return false;
    }
  }
  console.log(chalk.red('  ❌ RPC health check gagal setelah 3x retry (rate limited)'));
  return false;
}

// ─── Banner ─────────────────────────────────────────────────────────────────

function printBanner() {
  const plan = getPlanConfig();
  const enhancedApis = [];
  if (plan.useBatchAccounts) enhancedApis.push('BatchAccounts');
  if (plan.useEnhancedTx) enhancedApis.push('EnhancedTx');
  if (plan.useDAS) enhancedApis.push('DAS');
  if (plan.useSNS) enhancedApis.push('SNS');
  if (plan.useProgramAccounts) enhancedApis.push('ProgramAccounts');
  if (plan.detectProgramOwned) enhancedApis.push('PDA-Detect');
  const apiStr = enhancedApis.length > 0 ? enhancedApis.join(' · ') : 'Standard only';

  console.log(chalk.cyan(`
╔${'═'.repeat(62)}╗
║          🔍 SOLANA WALLET CHECKER BOT v${APP_VERSION} 🔍                 ║
║            Node.js + @solana/web3.js edition                   ║
║                                                                ║
║  Enhanced Analysis:                                            ║
║  • Jaccard Similarity · Gini Coefficient                       ║
║  • Funding Chain / Sybil Detection (${String(plan.fundingHops)}-hop)                   ║
║  • 🕵️  Insider/Team Detection (multi-signal)                   ║
║  • Inter-holder Transfer · Buy-Timing Correlation              ║
║  • 🏷️  SNS Domain Detection · DAS Token Discovery              ║
╚${'═'.repeat(62)}╝
`));
  console.log(chalk.gray(`  Plan: ${plan.description}`));
  console.log(chalk.gray(`  Rate: ${plan.maxRps} req/s | TX scan: ${plan.txHistoryPerWallet}/wallet | Funding: ${plan.fundingHops}-hop`));
  console.log(chalk.gray(`  APIs: ${apiStr}`));
  console.log('');
}

// ─── Wallet Report ──────────────────────────────────────────────────────────

const WALLET_COLORS = {
  [WalletType.FRESH]: chalk.green,
  [WalletType.SEMI_NEW]: chalk.yellow,
  [WalletType.OLD]: chalk.red,
};

const PROFILE_LABELS = {
  [WalletProfile.ORGANIC]: chalk.green('🧑 ORGANIC'),
  [WalletProfile.SNIPER_BOT]: chalk.red('🤖 SNIPER BOT'),
  [WalletProfile.COPY_TRADER]: chalk.yellow('📋 COPY TRADER'),
  [WalletProfile.DORMANT]: chalk.gray('💤 DORMANT'),
  [WalletProfile.FRESH_FUNDED]: chalk.magenta('🆕 FRESH FUNDED'),
};

function printWalletReport(walletInfo) {
  const color = WALLET_COLORS[walletInfo.walletType] || chalk.white;
  const ts = timestamp();
  const firstTx = formatDate(walletInfo.firstTransactionTime);
  const funder = truncateAddress(walletInfo.initialFunder);
  const balance = walletInfo.currentBalance !== null
    ? `${walletInfo.currentBalance.toFixed(4)} SOL`
    : 'Unknown';
  const age = walletInfo.walletAgeDays !== null
    ? `${walletInfo.walletAgeDays} days`
    : 'Unknown';
  const freq = walletInfo.txPerDay
    ? `${walletInfo.txPerDay} tx/day`
    : 'Unknown';
  const profileLabel = PROFILE_LABELS[walletInfo.profile] || walletInfo.profile;

  console.log(`
${chalk.cyan(`[${ts}]`)} ${chalk.white('NEW BUYER DETECTED')}
${chalk.white('─'.repeat(60))}
${chalk.white('Wallet:')}      ${walletInfo.address.slice(0, 20)}...${walletInfo.address.slice(-10)}
${chalk.white('Status:')}      ${color(`█ ${walletInfo.walletType} █`)}
${chalk.white('Profile:')}     ${profileLabel}
${chalk.white('Unique Tokens:')} ${walletInfo.uniqueTokenCount} different tokens traded
${chalk.white('Total Txns:')}   ${walletInfo.totalTransactions} transactions
${chalk.white('Wallet Age:')}   ${age} | Activity: ${freq}
${chalk.white('First Txn:')}    ${firstTx}
${chalk.white('Funded By:')}    ${funder}
${chalk.white('SOL Balance:')}  ${balance}
${chalk.white('─'.repeat(60))}
`);
}

// ─── Bot Class ──────────────────────────────────────────────────────────────

class WalletCheckerBot {
  constructor() {
    this.rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.wssUrl = process.env.SOLANA_WSS_URL || 'wss://api.mainnet-beta.solana.com';
    this.oldThreshold = parseInt(process.env.OLD_WALLET_THRESHOLD || '5', 10);
    this.pollInterval = parseInt(process.env.POLL_INTERVAL || '5', 10);

    this.analyzer = new WalletAnalyzer(this.rpcUrl, this.oldThreshold);
    this.monitor = null;
    this._analyzing = new Set();
  }

  async onTransactionDetected(buyerWallet, signature, tokenAddress) {
    if (this._analyzing.has(buyerWallet)) return;
    this._analyzing.add(buyerWallet);

    try {
      console.log(
        `${chalk.cyan(`[${timestamp()}]`)} Analyzing wallet: ${buyerWallet.slice(0, 20)}...`
      );
      const walletInfo = await this.analyzer.analyzeWallet(buyerWallet, tokenAddress);
      printWalletReport(walletInfo);
    } catch (err) {
      console.error(chalk.red(`Error analyzing wallet ${buyerWallet.slice(0, 20)}...: ${err.message}`));
    } finally {
      this._analyzing.delete(buyerWallet);
    }
  }

  async run(tokenAddress, useWebsocket = true) {
    console.log(`\n${chalk.green('Starting monitoring for token:')}`);
    console.log(`${chalk.white(tokenAddress)}\n`);
    console.log(`${chalk.yellow(`Mode: ${useWebsocket ? 'WebSocket' : 'Polling'}`)}`);
    console.log(`${chalk.yellow(`Threshold: ${this.oldThreshold} tokens = OLD wallet`)}`);
    console.log(`\n${chalk.cyan('Waiting for new transactions...')}\n`);

    this.monitor = new TransactionMonitor({
      rpcUrl: this.rpcUrl,
      wssUrl: this.wssUrl,
      tokenAddress,
      onTransaction: this.onTransactionDetected.bind(this),
      pollInterval: this.pollInterval,
    });

    // Handle graceful shutdown
    const shutdown = () => {
      console.log(chalk.yellow('\nReceived shutdown signal...'));
      this.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
      await this.monitor.start(useWebsocket);
    } catch (err) {
      if (err.message !== 'Monitoring stopped') {
        console.error(chalk.red(`Monitor error: ${err.message}`));
      }
    }
  }

  stop() {
    if (this.monitor) this.monitor.stop();
  }
}

// ─── Mode 3: Analyze Top Holders ───────────────────────────────────────────

async function analyzeTopHolders(tokenAddress) {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const plan = getPlanConfig();

  const maxHolders = plan.useProgramAccounts ? 200 : 50;
  console.log(chalk.yellow('\nHow many top holders to analyze?'));
  if (plan.useProgramAccounts) {
    console.log(`  ⚡ Paid plan: getProgramAccounts unlocks ALL holders (up to ${maxHolders})`);
    console.log(`  Recommended: 50-100 (balanced speed & coverage), Max: ${maxHolders}`);
  } else {
    console.log(`  Recommended: 15-20 (balanced speed and coverage)`);
    console.log('  ⚠️  Note: Free plan limited to ~20 largest accounts (Solana API limit)');
    console.log(`  Maximum: ${maxHolders}`);
  }

  const holderInput = await ask(chalk.green(`\nNumber of holders [default: ${plan.topHolders}] > `));
  let holderLimit = parseInt(holderInput, 10);
  if (isNaN(holderLimit)) holderLimit = plan.topHolders;
  holderLimit = Math.max(5, Math.min(maxHolders, holderLimit));

  console.log(chalk.cyan(`\n🔍 Analyzing Top ${holderLimit} Token Holders (${plan.name} mode)...\n`));

  const analyzer = new HolderAnalyzer(rpcUrl, plan);

  try {
    const result = await analyzer.getTokenHolders(tokenAddress, holderLimit);
    const holders = result.holders || result;  // backward compatible
    const filteredEntities = result.filteredEntities || [];
    if (!holders || holders.length === 0) {
      console.log(chalk.red('No holders found for this token.'));
      return;
    }

    // Step 1: Ask user which analyses to run
    console.log(chalk.yellow('\n📋 Available analysis modes:'));
    console.log('  [1] Quick    — Risk scoring + Gini + wallet age only');
    console.log('  [2] Standard — + Trading pattern similarity (Jaccard) + timing correlation');
    console.log('  [3] Deep     — + Funding chain + sybil + insider/team detection (RECOMMENDED)');

    const analysisMode = await ask(chalk.green('\nAnalysis depth [1/2/3, default: 3] > '));
    const mode = parseInt(analysisMode, 10) || 3;

    let similarityAnalysis = null;
    let fundingAnalysis = null;
    let insiderGroups = [];
    let fundingAna = null;
    let insiderDetector = null;

    // Step 2: Run similarity analysis (mode 2 & 3)
    if (mode >= 2) {
      similarityAnalysis = await analyzer.analyzeHolderSimilarities(holders, tokenAddress);
      if (similarityAnalysis.totalGroups > 0) {
        console.log(chalk.green(`\n✅ Found ${similarityAnalysis.totalGroups} similarity group(s) (Jaccard method)`));
      }
      if (similarityAnalysis.totalTimingClusters > 0) {
        console.log(chalk.green(`⏱️  Found ${similarityAnalysis.totalTimingClusters} timing cluster(s)`));
      }
    }

    // Step 3: Run funding chain analysis (mode 3)
    if (mode >= 3) {
      fundingAna = new FundingAnalyzer(rpcUrl, plan);
      fundingAnalysis = await fundingAna.analyzeFundingChains(holders);
      if (fundingAnalysis.totalClusters > 0) {
        console.log(chalk.green(`💰 Found ${fundingAnalysis.totalClusters} sybil cluster(s)`));
      }
      if (fundingAnalysis.totalSnipers > 0) {
        console.log(chalk.red(`🎯 Found ${fundingAnalysis.totalSnipers} sniper pattern(s)`));
      }

      // Step 4: Insider/Team Detection — combines ALL signals
      insiderDetector = new InsiderDetector(rpcUrl, plan.maxRps, plan);
      console.log(chalk.cyan('\n🕵️  Running insider/team detection...'));
      const interHolderTransfers = await insiderDetector.detectInterHolderTransfers(holders);

      // Step 4b: SNS Domain Detection (paid plan — identity signal)
      const snsDomains = await insiderDetector.detectSNSDomains(holders);

      insiderGroups = insiderDetector.detectInsiderGroups(
        holders, similarityAnalysis, fundingAnalysis, interHolderTransfers, snsDomains,
      );
      if (insiderGroups.length > 0) {
        const highConf = insiderGroups.filter(g => g.confidence >= 45).length;
        console.log(chalk.red(`\n🕵️  Detected ${insiderGroups.length} suspected insider group(s)${highConf > 0 ? ` (${highConf} high confidence!)` : ''}`));
      }
    }

    // Format and print full report
    const output = analyzer.formatHoldersOutput(holders, tokenAddress, similarityAnalysis, fundingAnalysis, filteredEntities);
    console.log(output);

    // Append insider groups
    let insiderOutput = '';
    if (insiderGroups.length > 0 && mode >= 3) {
      insiderOutput = insiderDetector.formatInsiderOutput(insiderGroups, holders, fundingAnalysis);
      console.log(insiderOutput);
    }

    // Append funding analysis to output if mode 3
    let fundingOutput = '';
    if (fundingAnalysis && mode >= 3) {
      fundingOutput = fundingAna.formatFundingOutput(fundingAnalysis, holders);
      console.log(fundingOutput);
    }

    // ── PnL & Early Buyer Analysis (mode ≥ 2) ──
    let pnlOutput = '';
    if (mode >= 2) {
      console.log(chalk.cyan('\n💰 Fetching current price from Jupiter...'));
      const currentPrice = await getCurrentPrice(tokenAddress);
      if (currentPrice) {
        console.log(chalk.green(`  ✅ Price: ${currentPrice.priceSOL.toExponential(2)} SOL ($${currentPrice.priceUSD.toExponential(2)})`));
        const pnlAnalysis = analyzeEarlyBuyers(holders, currentPrice, similarityAnalysis, fundingAnalysis);
        pnlOutput = formatPnLOutput(pnlAnalysis, holders);
        console.log(pnlOutput);

        if (pnlAnalysis.earlyBuyers.length > 0) {
          console.log(chalk.red(`  🏆 Detected ${pnlAnalysis.earlyBuyers.length} early buyer(s) still holding!`));
        }
        if (pnlAnalysis.crossReferences.length > 0) {
          console.log(chalk.red(`  🚨 ${pnlAnalysis.crossReferences.length} cross-reference alert(s) — profitable wallets in suspicious groups!`));
        }
      } else {
        pnlOutput = '\n⚠️  Price data unavailable — PnL analysis skipped.\n';
        console.log(chalk.yellow(pnlOutput));
      }
    }

    // Save to file
    const save = await ask(chalk.green('\nSave to file? [y/N] > '));
    if (save.toLowerCase() === 'y') {
      const filename = `holders_${tokenAddress.slice(0, 8)}_${new Date().toISOString().replace(/[:.T]/g, '').slice(0, 15)}.txt`;
      writeFileSync(filename, output + insiderOutput + fundingOutput + pnlOutput, 'utf-8');
      console.log(chalk.green(`✅ Saved to ${filename}`));
    }
  } catch (err) {
    console.error(chalk.red(`Error analyzing holders: ${err.message}`));
  }
}

// ─── Mode 4: Import & Analyze from CSV ─────────────────────────────────────

async function analyzeFromCSV() {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

  console.log(chalk.cyan('\n📁 IMPORT & ANALYZE FROM CSV'));
  console.log(chalk.white('='.repeat(60) + '\n'));

  console.log(chalk.yellow('Enter CSV file path:'));
  console.log('  Example: holders.csv');
  console.log('  Or full path: /path/to/holders.csv');

  const csvPath = await ask(chalk.green('\nFile path > '));
  if (!csvPath) {
    console.log(chalk.red('No file path provided.'));
    return;
  }

  // Get token address (optional)
  console.log(chalk.yellow('\nEnter token address (optional):'));
  console.log('  This will be used for trading history analysis');
  const tokenAddress = await ask(chalk.green('\nToken address [press Enter to skip] > ')) || null;

  console.log(chalk.cyan('\n🔍 Importing CSV...\n'));

  const importer = new CSVImporter();

  try {
    // Validate CSV
    const validation = importer.validateCSVFormat(csvPath);
    if (!validation.valid) {
      console.log(chalk.red('❌ Invalid CSV format'));
      console.log(validation.error || 'Missing required columns (Address, Balance/Quantity)');
      return;
    }

    console.log(chalk.green('✅ CSV format valid'));
    console.log(`   Rows: ${validation.rowCount}`);
    console.log(`   Columns: ${validation.headers.slice(0, 5).join(', ')}...`);

    // Parse CSV
    const data = importer.parseCSV(csvPath, tokenAddress);
    const holders = data.holders;

    console.log(chalk.green(`\n✅ Successfully imported ${holders.length} holders`));
    console.log(`   Total balance: ${data.totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })} tokens`);

    // Ask for similarity analysis
    console.log(chalk.yellow('\nPerform trading pattern similarity analysis?'));
    console.log('  This will fetch trading history for each wallet');
    console.log('  ⚠️  This may take 5-15 minutes for 100 holders');

    const analyzeSim = await ask(chalk.green('\nAnalyze similarities? [y/N] > '));

    let similarityAnalysis = null;
    let finalTokenAddress = tokenAddress;

    if (analyzeSim.toLowerCase() === 'y') {
      if (!finalTokenAddress) {
        console.log(chalk.yellow('\n⚠️  Token address required for similarity analysis'));
        finalTokenAddress = await ask(chalk.green('Token address > ')) || null;
      }

      if (finalTokenAddress) {
        const analyzer = new HolderAnalyzer(rpcUrl, getPlanConfig());
        try {
          console.log(chalk.cyan('\n🔍 Analyzing trading patterns...'));
          similarityAnalysis = await analyzer.analyzeHolderSimilarities(holders, finalTokenAddress);
          if (similarityAnalysis.totalGroups > 0) {
            console.log(chalk.green(`\n✅ Found ${similarityAnalysis.totalGroups} group(s) with similar trading patterns!`));
          } else {
            console.log(chalk.yellow('\nNo significant trading pattern similarities found.'));
          }
        } catch (err) {
          console.error(chalk.red(`\nError in similarity analysis: ${err.message}`));
        }
      }
    }

    // Format and display output with risk scoring
    console.log(chalk.cyan('\n📊 Generating risk analysis report...\n'));

    const analyzer = new HolderAnalyzer(rpcUrl, getPlanConfig());
    const output = analyzer.formatHoldersOutput(holders, finalTokenAddress || 'Unknown', similarityAnalysis);
    console.log(output);

    // Save to file
    const save = await ask(chalk.green('\nSave to file? [y/N] > '));
    if (save.toLowerCase() === 'y') {
      const filename = `analysis_imported_${new Date().toISOString().replace(/[:.T]/g, '').slice(0, 15)}.txt`;
      writeFileSync(filename, output, 'utf-8');
      console.log(chalk.green(`✅ Saved to ${filename}`));
    }
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`));
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  // RPC health check
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  console.log(chalk.gray(`  Checking RPC: ${rpcUrl.slice(0, 50)}...`));
  const healthy = await checkRpcHealth(rpcUrl);
  if (!healthy) {
    const cont = await ask(chalk.yellow('\nLanjutkan tanpa RPC yang valid? [y/N] > '));
    if (cont.toLowerCase() !== 'y') process.exit(1);
  }
  console.log('');

  console.log(chalk.white('Select operation mode:'));
  console.log('  1. Monitor Real-time Token Purchases (WebSocket)');
  console.log('  2. Monitor Real-time Token Purchases (Polling only)');
  console.log('  3. Deep Token Holder Analysis (Jaccard + Gini + Sybil) 🔥');
  console.log('  4. Import & Analyze from CSV (Solscan export - supports 100+)');

  const mainMode = await ask(chalk.green('\nSelect Mode [1/2/3/4] > '));

  // Mode 4: CSV import
  if (mainMode === '4') {
    await analyzeFromCSV();
    return;
  }

  // Get token address (for modes 1, 2, 3)
  console.log(chalk.white('\nEnter the token address:'));
  console.log(chalk.cyan('(Example: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC)'));

  const tokenAddress = await ask(chalk.green('\nToken Address > '));

  if (!tokenAddress) {
    console.log(chalk.red('Error: Token address is required.'));
    process.exit(1);
  }

  if (!validateSolanaAddress(tokenAddress)) {
    console.log(chalk.red('Error: Invalid Solana address format.'));
    process.exit(1);
  }

  // Mode 3: Analyze top holders
  if (mainMode === '3') {
    await analyzeTopHolders(tokenAddress);
    return;
  }

  // Mode 1 or 2: Real-time monitoring
  const useWebsocket = mainMode === '1';
  const bot = new WalletCheckerBot();

  try {
    await bot.run(tokenAddress, useWebsocket);
  } catch (err) {
    console.error(chalk.red(`Fatal error: ${err.message}`));
    bot.stop();
    process.exit(1);
  }
}

// Entry point
main().catch(err => {
  console.error(chalk.red(`Unhandled error: ${err.message}`));
  process.exit(1);
});
