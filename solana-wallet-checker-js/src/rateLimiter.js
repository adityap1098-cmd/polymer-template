/**
 * Rate Limiter for Solana RPC calls.
 * Ensures we don't exceed QuickNode/RPC rate limits.
 * 
 * Uses a token bucket algorithm with queuing.
 */

import { sleep } from './utils.js';

export class RateLimiter {
  /**
   * @param {number} maxPerSecond - Maximum requests per second (default: 12)
   */
  constructor(maxPerSecond = 12) {
    this.minInterval = Math.ceil(1000 / maxPerSecond); // ms between requests
    this.lastCall = 0;
    this.queue = [];
    this.processing = false;
    this._retryCount = 0;
    this._maxRetryCount = 0;
  }

  /**
   * Wait for rate limit slot, then execute.
   * @returns {Promise<void>}
   */
  async acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const elapsed = now - this.lastCall;
      
      // If we've been getting 429s, increase the delay
      const effectiveInterval = this._retryCount > 0
        ? this.minInterval * Math.min(4, 1 + this._retryCount * 0.5)
        : this.minInterval;

      if (elapsed < effectiveInterval) {
        await sleep(effectiveInterval - elapsed);
      }

      this.lastCall = Date.now();
      const resolve = this.queue.shift();
      resolve();
    }

    this.processing = false;
  }

  /**
   * Call this when a 429 is received to back off.
   */
  onRateLimit() {
    this._retryCount = Math.min(this._retryCount + 1, 10);
    this._maxRetryCount = Math.max(this._maxRetryCount, this._retryCount);
  }

  /**
   * Call this on successful request to slowly recover.
   */
  onSuccess() {
    if (this._retryCount > 0) {
      this._retryCount = Math.max(0, this._retryCount - 0.1);
    }
  }
}

/**
 * Custom RPC client with built-in rate limiting.
 * Replaces direct @solana/web3.js calls to avoid 429 spam.
 */
export class RateLimitedRPC {
  /**
   * @param {string} rpcUrl 
   * @param {number} maxPerSecond 
   */
  constructor(rpcUrl, maxPerSecond = 12) {
    this.rpcUrl = rpcUrl;
    this.limiter = new RateLimiter(maxPerSecond);
    this._requestCount = 0;
    this._errorCount = 0;
  }

  /**
   * Make a rate-limited JSON-RPC call.
   * @param {string} method 
   * @param {Array|Object} params - Array for standard RPC, Object for DAS methods
   * @param {number} maxRetries
   * @returns {Promise<any>}
   */
  async call(method, params, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await this.limiter.acquire();
      this._requestCount++;

      try {
        const response = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: this._requestCount,
            method,
            params,
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (response.status === 429) {
          this._errorCount++;
          this.limiter.onRateLimit();
          const backoff = Math.min(2000, 500 * Math.pow(2, attempt));
          // Only log once every 10 rate limits to avoid spam
          if (this._errorCount % 10 === 1) {
            console.log(`⏳ Rate limited (${this._errorCount}x total), backing off ${backoff}ms...`);
          }
          await sleep(backoff);
          continue;
        }

        const data = await response.json();
        
        if (data.error) {
          // Handle rate limit error in response body
          if (data.error.code === 429 || (typeof data.error.message === 'string' && data.error.message.includes('429'))) {
            this._errorCount++;
            this.limiter.onRateLimit();
            const backoff = Math.min(3000, 500 * Math.pow(2, attempt));
            if (this._errorCount % 10 === 1) {
              console.log(`⏳ Rate limited (${this._errorCount}x total), backing off ${backoff}ms...`);
            }
            await sleep(backoff);
            continue;
          }
          throw new Error(`RPC Error: ${JSON.stringify(data.error)}`);
        }

        this.limiter.onSuccess();
        return data.result;
      } catch (err) {
        if (err.message?.startsWith('RPC Error')) throw err;
        if (attempt === maxRetries - 1) throw err;
        await sleep(1000 * (attempt + 1));
      }
    }

    throw new Error(`RPC call ${method} failed after ${maxRetries} retries`);
  }

  /**
   * Get stats for debugging.
   */
  getStats() {
    return {
      totalRequests: this._requestCount,
      totalErrors: this._errorCount,
    };
  }
}
