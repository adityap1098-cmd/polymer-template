/**
 * Transaction Monitor Module for Solana Wallet Checker Bot.
 * Monitors real-time token transactions on Solana.
 * 
 * Migrated from Python to Node.js with @solana/web3.js + ws
 */

import { Connection, PublicKey } from '@solana/web3.js';
import WebSocket from 'ws';
import { sleep, TOKEN_PROGRAM_ID } from './utils.js';

export class TransactionMonitor {
  /**
   * @param {object} options
   * @param {string} options.rpcUrl - Solana RPC endpoint URL
   * @param {string} options.wssUrl - Solana WebSocket endpoint URL
   * @param {string} options.tokenAddress - Token mint address to monitor  
   * @param {Function} options.onTransaction - Callback when transaction detected
   * @param {number} [options.pollInterval=5] - Polling interval in seconds
   */
  constructor({ rpcUrl, wssUrl, tokenAddress, onTransaction, pollInterval = 5 }) {
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: wssUrl,
    });
    this.rpcUrl = rpcUrl;
    this.wssUrl = wssUrl;
    this.tokenAddress = tokenAddress;
    this.onTransaction = onTransaction;
    this.pollInterval = pollInterval;
    this._running = false;
    this._processedSignatures = new Set();
    this._lastRpcCall = 0;
    this._minRpcInterval = 50; // ms
    this._rateLimitSleep = 1000; // ms
    this._wsSubscriptionId = null;
  }

  /**
   * Rate-limited delay between RPC calls.
   */
  async _rateLimit() {
    const now = Date.now();
    const timeSinceLast = now - this._lastRpcCall;
    if (timeSinceLast < this._minRpcInterval) {
      await sleep(this._minRpcInterval - timeSinceLast);
    }
    this._lastRpcCall = Date.now();
  }

  /**
   * Get recent transaction signatures for the token.
   * @param {number} limit 
   * @returns {Promise<Array>}
   */
  async _getSignaturesForToken(limit = 20) {
    await this._rateLimit();
    try {
      const pubkey = new PublicKey(this.tokenAddress);
      return await this.connection.getSignaturesForAddress(pubkey, { limit });
    } catch (err) {
      throw new Error(`Failed to get signatures: ${err.message}`);
    }
  }

  /**
   * Get parsed transaction details.
   * @param {string} signature 
   * @returns {Promise<object|null>}
   */
  async _getTransaction(signature) {
    await this._rateLimit();
    try {
      return await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
    } catch (err) {
      return null;
    }
  }

  /**
   * Extract buyer wallet addresses from a transaction.
   * @param {object} transaction 
   * @returns {string[]}
   */
  _extractBuyerWallets(transaction) {
    const buyers = [];
    if (!transaction || !transaction.meta) return buyers;

    const meta = transaction.meta;
    const preBalances = meta.preTokenBalances || [];
    const postBalances = meta.postTokenBalances || [];

    // Create maps for comparison
    const preMap = new Map();
    for (const bal of preBalances) {
      if (bal.mint === this.tokenAddress) {
        const owner = bal.owner;
        const amount = parseFloat(bal.uiTokenAmount?.uiAmount || 0);
        if (owner) preMap.set(owner, amount);
      }
    }

    const postMap = new Map();
    for (const bal of postBalances) {
      if (bal.mint === this.tokenAddress) {
        const owner = bal.owner;
        const amount = parseFloat(bal.uiTokenAmount?.uiAmount || 0);
        if (owner) postMap.set(owner, amount);
      }
    }

    // Find wallets that increased their token balance (buyers)
    const allOwners = new Set([...preMap.keys(), ...postMap.keys()]);
    for (const owner of allOwners) {
      const preAmount = preMap.get(owner) || 0;
      const postAmount = postMap.get(owner) || 0;
      if (postAmount > preAmount) {
        buyers.push(owner);
      }
    }

    return buyers;
  }

  /**
   * Poll for new transactions periodically.
   */
  async _pollTransactions() {
    const ts = () => new Date().toTimeString().split(' ')[0];
    console.log(`[${ts()}] Starting transaction polling...`);

    while (this._running) {
      try {
        const signatures = await this._getSignaturesForToken(20);

        for (const sigInfo of (signatures || [])) {
          const signature = sigInfo.signature;
          if (!signature || this._processedSignatures.has(signature)) continue;

          this._processedSignatures.add(signature);

          // Keep only last 1000 signatures in memory
          if (this._processedSignatures.size > 1000) {
            const arr = [...this._processedSignatures];
            this._processedSignatures = new Set(arr.slice(-500));
          }

          // Get transaction details
          try {
            const tx = await this._getTransaction(signature);
            if (tx) {
              const buyers = this._extractBuyerWallets(tx);
              for (const buyer of buyers) {
                await this.onTransaction(buyer, signature, this.tokenAddress);
              }
            }
          } catch (err) {
            console.error(`Error getting transaction ${signature.slice(0, 20)}...: ${err.message}`);
          }
        }

        await sleep(this.pollInterval * 1000);
      } catch (err) {
        console.error(`Polling error: ${err.message}`);
        await sleep(this.pollInterval * 1000);
      }
    }
  }

  /**
   * Subscribe to token transactions via WebSocket using raw ws.
   */
  async _websocketSubscribe() {
    const ts = () => new Date().toTimeString().split(' ')[0];
    console.log(`[${ts()}] Connecting to WebSocket...`);

    while (this._running) {
      try {
        await new Promise((resolve, reject) => {
          const ws = new WebSocket(this.wssUrl);
          this._ws = ws;

          ws.on('open', () => {
            console.log(`[${ts()}] WebSocket connected, monitoring token...`);
            
            // Subscribe to logs that mention our token
            const subscribeMsg = JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'logsSubscribe',
              params: [
                { mentions: [this.tokenAddress] },
                { commitment: 'confirmed' },
              ],
            });
            ws.send(subscribeMsg);
          });

          ws.on('message', async (data) => {
            if (!this._running) {
              ws.close();
              return;
            }

            try {
              const message = JSON.parse(data.toString());

              // Handle subscription confirmation
              if (message.result && typeof message.result === 'number') {
                console.log(`[${ts()}] Subscription confirmed: ${message.result}`);
                this._wsSubscriptionId = message.result;
                return;
              }

              // Handle log notifications
              if (message.method === 'logsNotification') {
                const value = message.params?.result?.value;
                const signature = value?.signature;

                if (signature && !this._processedSignatures.has(signature)) {
                  this._processedSignatures.add(signature);

                  try {
                    const tx = await this._getTransaction(signature);
                    if (tx) {
                      const buyers = this._extractBuyerWallets(tx);
                      for (const buyer of buyers) {
                        await this.onTransaction(buyer, signature, this.tokenAddress);
                      }
                    }
                  } catch (err) {
                    if (err.message?.includes('429')) {
                      await sleep(this._rateLimitSleep);
                    }
                    console.error(`Error processing tx: ${err.message}`);
                  }
                }
              }
            } catch (err) {
              // JSON parse error, ignore
            }
          });

          ws.on('close', () => {
            if (this._running) {
              console.log('WebSocket disconnected, reconnecting in 5s...');
              setTimeout(() => resolve(), 5000);
            } else {
              resolve();
            }
          });

          ws.on('error', (err) => {
            if (this._running) {
              console.error(`WebSocket error: ${err.message}, reconnecting in 5s...`);
              ws.close();
              setTimeout(() => resolve(), 5000);
            } else {
              resolve();
            }
          });
        });
      } catch (err) {
        if (this._running) {
          console.error(`WebSocket connection failed: ${err.message}`);
          await sleep(5000);
        }
      }
    }
  }

  /**
   * Start monitoring transactions.
   * @param {boolean} useWebsocket - Use WebSocket (true) or polling (false)
   */
  async start(useWebsocket = true) {
    this._running = true;

    // Pre-populate processed signatures to avoid reporting old transactions
    try {
      const signatures = await this._getSignaturesForToken(50);
      this._processedSignatures = new Set(
        (signatures || []).map(s => s.signature).filter(Boolean)
      );
      const ts = new Date().toTimeString().split(' ')[0];
      console.log(`[${ts}] Loaded ${this._processedSignatures.size} existing signatures`);
    } catch (err) {
      console.warn(`Warning: Could not load existing signatures: ${err.message}`);
    }

    if (useWebsocket) {
      await this._websocketSubscribe();
    } else {
      await this._pollTransactions();
    }
  }

  /**
   * Stop monitoring transactions.
   */
  stop() {
    this._running = false;
    if (this._ws) {
      try { this._ws.close(); } catch (e) { /* ignore */ }
    }
  }
}
