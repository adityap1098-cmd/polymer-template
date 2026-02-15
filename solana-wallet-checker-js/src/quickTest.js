/**
 * Quick integration test - directly calls HolderAnalyzer to test live RPC.
 * Usage: node src/quickTest.js
 */

import 'dotenv/config';
import { HolderAnalyzer } from './holderAnalyzer.js';
import { WalletAnalyzer, WalletType } from './walletAnalyzer.js';

const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function testHolderAnalysis() {
  console.log('=== TEST 1: Holder Analysis (USDC, top 5) ===\n');
  console.log(`RPC: ${rpcUrl.slice(0, 40)}...`);
  
  const analyzer = new HolderAnalyzer(rpcUrl);

  try {
    const holders = await analyzer.getTokenHolders(USDC_MINT, 5);
    
    if (!holders || holders.length === 0) {
      console.error('❌ FAIL: No holders returned');
      return false;
    }

    console.log(`\n✅ Got ${holders.length} holders:`);
    for (const h of holders) {
      console.log(`  ${h.owner.slice(0, 12)}... | Balance: ${h.balance.toLocaleString()} | Purchase: ${h.purchaseTimeStr}`);
    }

    // Test risk scoring
    const output = analyzer.formatHoldersOutput(holders, USDC_MINT, null);
    console.log('\n✅ Risk analysis output generated (' + output.length + ' chars)');
    
    return true;
  } catch (err) {
    console.error(`❌ FAIL: ${err.message}`);
    return false;
  }
}

async function testWalletAnalysis() {
  console.log('\n\n=== TEST 2: Wallet Analysis (known wallet) ===\n');
  
  const analyzer = new WalletAnalyzer(rpcUrl, 5);
  // Use a known active wallet (Raydium Authority)
  const testWallet = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

  try {
    const info = await analyzer.analyzeWallet(testWallet);
    
    console.log(`✅ Wallet Analysis Result:`);
    console.log(`  Address: ${info.address.slice(0, 20)}...`);
    console.log(`  Type: ${info.walletType}`);
    console.log(`  Unique Tokens: ${info.uniqueTokenCount}`);
    console.log(`  Total Tx: ${info.totalTransactions}`);
    console.log(`  Balance: ${info.currentBalance?.toFixed(4)} SOL`);
    console.log(`  First Tx: ${info.firstTransactionTime || 'Unknown'}`);
    console.log(`  Funder: ${info.initialFunder ? info.initialFunder.slice(0, 12) + '...' : 'Unknown'}`);
    
    return true;
  } catch (err) {
    console.error(`❌ FAIL: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('🚀 Solana Wallet Checker - Live Integration Test\n');
  
  const r1 = await testHolderAnalysis();
  const r2 = await testWalletAnalysis();
  
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${r1 ? '✅' : '❌'} Holder Analysis | ${r2 ? '✅' : '❌'} Wallet Analysis`);
  console.log('='.repeat(50));
  
  process.exit(r1 && r2 ? 0 : 1);
}

main();
