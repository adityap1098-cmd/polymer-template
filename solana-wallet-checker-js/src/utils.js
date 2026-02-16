/**
 * Shared Utilities — Common functions used across multiple modules.
 * 
 * Centralizes: sleep, TOKEN constants, timestamp/address formatting.
 * Eliminates duplicate definitions in rateLimiter, walletAnalyzer,
 * transactionMonitor, holderAnalyzer, insiderDetector.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** App version — single source of truth */
export const APP_VERSION = '3.2.0';

// ─── Timing ─────────────────────────────────────────────────────────────────

/**
 * Async sleep/delay.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format a Date to "YYYY-MM-DD HH:mm:ss" string.
 * @param {Date|null} date
 * @returns {string}
 */
export function formatDate(date) {
  if (!date) return 'Unknown';
  return date.toISOString().replace('T', ' ').split('.')[0];
}

/**
 * Truncate a Solana address to "XXXX...XXXX" format.
 * @param {string} addr
 * @param {number} [chars=8] - Characters to keep on each side
 * @returns {string}
 */
export function truncateAddress(addr, chars = 8) {
  if (!addr) return 'Unknown';
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

/**
 * Get current time as HH:mm:ss string.
 * @returns {string}
 */
export function timestamp() {
  return new Date().toTimeString().split(' ')[0];
}
