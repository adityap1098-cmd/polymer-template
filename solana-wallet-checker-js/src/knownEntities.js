/**
 * Known Entities Database — Exchanges, DEXes, Programs, Tokens.
 * 
 * Used to filter out non-human wallets from holder analysis,
 * and to exclude universal tokens from similarity scoring.
 * 
 * Detection strategy (layered):
 *   1. Static lists (EXCHANGE_WALLETS, LIQUIDITY_PROGRAMS) — instant lookup
 *   2. isOnCurve check (PublicKey.isOnCurve) — FREE, zero RPC, catches all PDAs
 *   3. Owner program check (getMultipleAccounts) — labels specific programs
 * 
 * Sources: Solscan labels, Arkham Intelligence, public documentation.
 * Last updated: 2026-02-16
 */

// ─── KNOWN EXCHANGE HOT WALLETS / DEPOSIT ADDRESSES ────────────────────────
// These hold tokens on behalf of millions of users — NOT individual holders.

export const EXCHANGE_WALLETS = new Map([
  // Binance
  ['5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', 'Binance'],
  ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'Binance'],
  ['3yFwqXBfZY4jBVUafQ1YEXw189y2dN3V5KQq9uzBDy1E', 'Binance'],
  ['2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S', 'Binance'],
  ['AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', 'Binance'],

  // Coinbase
  ['2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', 'Coinbase'],
  ['H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'Coinbase'],
  ['GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', 'Coinbase'],

  // Kraken
  ['FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', 'Kraken'],

  // OKX (OKEx)
  ['5VCwKtCXgCJ6kit5FybXjvFocNUJa8rS68N2iP3yYawJ', 'OKX'],
  ['JA5y5BQUV3sMsv6M8WxpJKzwKJRxR9pvnBJiGzJAUvP8', 'OKX'],

  // Bybit
  ['HdsLDfDdcWwj1qTRj2u88HuXpTFMoMCRjqN6CJ5LGX6v', 'Bybit'],
  ['7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs', 'Bybit'],

  // HTX (Huobi)
  ['46mELQVECSTADmwNaJNkBQo1RZoojSkXr6nSyRRk17y7', 'HTX'],

  // Upbit
  ['DCzJVXamcGmjCJX5oWJuEU1RNDEz1Kgmh5TwG53N1bGp', 'Upbit'],

  // Crypto.com
  ['AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQ5ATbo3s', 'Crypto.com'],

  // Gemini
  ['GhcGFRubWktQTG5Rz4wxVRN1LhoN3HYRGKzRwzK3CLSB', 'Gemini'],

  // Backpack
  ['GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npQ', 'Backpack'],

  // KuCoin
  ['BmFdpraQhkiDQE6SnfG5PvR4r59BNGYSMuxCEMcRMaaM', 'KuCoin'],

  // Gate.io
  ['u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w', 'Gate.io'],

  // Bitget
  ['7rhxnLV8C8Bn3Mtt7GHbeGmFtYqAEfeRFu4urBVqC7TM', 'Bitget'],

  // MXC / MEXC
  ['ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', 'MEXC'],

  // Raydium Authority (not a person)
  ['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 'Raydium Authority'],

  // ChangeNow
  ['G2YxRa6wt1qePMwfJzdXZG62ej4qaTC7YURzuh2Lwd3t', 'ChangeNow'],

  // Known Bots / Volume Bots / MEV
  ['5Z84wihCtpNP9W58KoExJ5e9CG4SP2QUUg6tsnXb9WGF', '⚡ BoostLegends VolumeBot'],
  ['po27vzv7pSZYsroDopmGVVBVAqxg4GcyZXxmCkoejFB', '🤖 Sniper MEV Bot'],
]);

// ─── KNOWN DEX / LIQUIDITY / PROGRAM WALLETS ───────────────────────────────
// These are smart contract program IDs or authority wallets.
// They hold tokens as part of liquidity pools — NOT individual holders.

export const LIQUIDITY_PROGRAMS = new Set([
  // Raydium
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Raydium AMM V4
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',  // Raydium Authority
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM
  'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',   // Raydium Route
  'FarmqiPv5eAj3j1GMdMCMUGXqPUvmquZtMy86QH6rzhG',  // Raydium Farms

  // Orca
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   // Orca Whirlpool
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',  // Orca V1
  'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1',  // Orca V2

  // Jupiter
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',   // Jupiter V6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',   // Jupiter V4
  'JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uN9CFi',  // Jupiter V2

  // Pump.fun
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',  // Pump.fun Program
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp18W',  // Pump.fun Fee Authority
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ9BSKKbV14p',  // Pump.fun Bonding Curve Auth
  'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9oYFa2Bh',  // Pump.fun Migration Authority
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',  // Pump.fun DEX
  'FWMFkL4gJbLphiEejbt6KDj5FbN6cYAbyMfDUZ4dfFdb',  // Pump.fun LP Token vault
  '2DxxYabaeF2eCi2duW9EA9QNr1UjAPqyMXrWmYW7ZxSD',  // Pump.fun Liquidity Wallet
  '6UxXQsbGLc6r3cet3z5bqM7mMYxmbawkDpRx4Ku8RaqX',  // Pump.fun ALIENSCANNER Bonding Curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',   // Pump.fun AMM

  // Meteora
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',   // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',  // Meteora Pools

  // Phoenix
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',   // Phoenix DEX

  // OpenBook / Serum
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',    // Serum V3
  'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',    // OpenBook V2

  // Marinade
  'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',    // Marinade Staking

  // System / Token programs (not people)
  '11111111111111111111111111111111',                  // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',     // Token Program
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',     // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',    // Associated Token
  'ComputeBudget111111111111111111111111111111',       // Compute Budget
]);

// ─── UNIVERSAL TOKENS TO EXCLUDE FROM SIMILARITY ANALYSIS ──────────────────
// Tokens that virtually ALL wallets interact with.
// Including these inflates Jaccard similarity to false positives.

export const UNIVERSAL_TOKENS = new Set([
  // Wrapped SOL — literally every wallet has this
  'So11111111111111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',

  // USDC — most common stablecoin on Solana
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',

  // USDT — second most common stablecoin
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',

  // BONK — massive airdrop, nearly all wallets received
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',

  // JUP — airdropped to millions
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',

  // WEN — massive community airdrop
  'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk',

  // PYTH — airdrop token
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',

  // JTO — Jito airdrop
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',

  // W — Wormhole airdrop
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',

  // Raydium RAY
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',

  // Native SOL mint (used internally)
  '11111111111111111111111111111111',
]);

// ─── KNOWN PROGRAM IDs → LABELS ────────────────────────────────────────────
// Maps on-chain program owner IDs to human-readable labels.
// Used for DYNAMIC PDA detection: if a wallet's owner is one of these programs,
// it's a Program Derived Address (liquidity pool, bonding curve, etc.).
//
// Key insight: user wallets are owned by System Program (1111...111).
// Any wallet owned by a different program = PDA = not a human holder.

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

export const KNOWN_PROGRAM_LABELS = new Map([
  // ── Pump.fun ──
  ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', '🐸 Pump.fun Bonding Curve'],
  ['39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', '🐸 Pump.fun Program'],
  ['BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9oYFa2Bh', '🐸 Pump.fun Migration'],
  ['Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp18W', '🐸 Pump.fun Fee'],
  ['CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ9BSKKbV14p', '🐸 Pump.fun Auth'],
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', '🐸 Pump.fun AMM'],

  // ── Raydium ──
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', '💧 Raydium AMM V4'],
  ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', '💧 Raydium CLMM'],
  ['routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',  '💧 Raydium Route'],
  ['FarmqiPv5eAj3j1GMdMCMUGXqPUvmquZtMy86QH6rzhG', '💧 Raydium Farms'],
  ['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', '💧 Raydium Authority'],

  // ── Orca ──
  ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', '🌊 Orca Whirlpool'],
  ['9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', '🌊 Orca V1'],
  ['DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', '🌊 Orca V2'],

  // ── Jupiter ──
  ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', '⚡ Jupiter V6'],
  ['JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', '⚡ Jupiter V4'],
  ['JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uN9CFi', '⚡ Jupiter V2'],

  // ── Meteora ──
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', '🌀 Meteora DLMM'],
  ['Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', '🌀 Meteora Pools'],

  // ── Phoenix / OpenBook / Serum ──
  ['PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', '🔥 Phoenix DEX'],
  ['srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', '📖 Serum V3'],
  ['opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb', '📖 OpenBook V2'],

  // ── Marinade ──
  ['MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD', '🏔️ Marinade Staking'],

  // ── Token Programs ──
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', '🔑 Token Program'],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', '🔑 Token-2022'],
  ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', '🔑 Associated Token'],
]);

// ─── HELPER FUNCTIONS ──────────────────────────────────────────────────────

/**
 * Check if a wallet is a known exchange.
 * @param {string} address
 * @returns {{isExchange: boolean, name: string|null}}
 */
export function identifyExchange(address) {
  const name = EXCHANGE_WALLETS.get(address);
  return { isExchange: !!name, name: name || null };
}

/**
 * Check if a wallet is a known liquidity/program address.
 * @param {string} address
 * @returns {boolean}
 */
export function isLiquidityProgram(address) {
  return LIQUIDITY_PROGRAMS.has(address);
}

/**
 * Check if a token is a universal/common token that should be excluded
 * from similarity analysis.
 * @param {string} mint
 * @returns {boolean}
 */
export function isUniversalToken(mint) {
  return UNIVERSAL_TOKENS.has(mint);
}

/**
 * Get the human-readable label for a known program (by its program ID).
 * Used for dynamic PDA detection — identifies what program owns a wallet.
 * @param {string} programId - The program that owns the account
 * @returns {string|null} Human label or null if unknown
 */
export function getProgramLabel(programId) {
  return KNOWN_PROGRAM_LABELS.get(programId) || null;
}

/**
 * Check if an account is a user wallet (owned by System Program)
 * vs a Program Derived Address (owned by any other program).
 * @param {string} ownerProgram - The .owner field from getAccountInfo
 * @returns {boolean} true if user wallet, false if PDA
 */
export function isUserWallet(ownerProgram) {
  return ownerProgram === SYSTEM_PROGRAM_ID;
}

/**
 * Get the label for a known entity.
 * @param {string} address
 * @returns {string|null}
 */
export function getEntityLabel(address) {
  const exchange = EXCHANGE_WALLETS.get(address);
  if (exchange) return `🏦 ${exchange}`;

  if (LIQUIDITY_PROGRAMS.has(address)) return '🔄 Liquidity/DEX';

  const programLabel = KNOWN_PROGRAM_LABELS.get(address);
  if (programLabel) return programLabel;

  return null;
}
