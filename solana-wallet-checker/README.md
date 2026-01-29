# Solana Wallet Checker Bot 🔍

A Python bot for monitoring Solana token transactions in real-time and classifying wallets based on their transaction history.

## Features

- **Real-time Monitoring**: Monitors token purchases via WebSocket or polling
- **Wallet Classification**:
  - 🟢 **FRESH**: Wallet has no other token transactions (first-time buyer)
  - 🟡 **SEMI-NEW**: Wallet has less than 5 different token transactions
  - 🔴 **OLD**: Wallet has 5 or more different token transactions
- **Wallet Analysis**:
  - When the wallet was created (first transaction time)
  - Initial funding source (who sent SOL to this wallet)
  - Current SOL balance
  - Total transaction count

## Requirements

- Python 3.8+
- Solana RPC endpoint (QuickNode recommended, or free public endpoint)

## Installation

1. Navigate to the solana-wallet-checker directory:
   ```bash
   cd solana-wallet-checker
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Configure your environment:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` with your RPC endpoints (optional - defaults to public Solana RPC):
   ```
   QUICKNODE_RPC_URL=https://your-endpoint.solana-mainnet.quiknode.pro/your-api-key/
   QUICKNODE_WSS_URL=wss://your-endpoint.solana-mainnet.quiknode.pro/your-api-key/
   ```

## Usage

Run the bot:
```bash
python main.py
```

The bot will prompt you for:
1. **Token Address**: The Solana token mint address to monitor
2. **Monitoring Mode**: WebSocket (real-time) or Polling (fallback)

### Example Session

```
╔══════════════════════════════════════════════════════════════╗
║          🔍 SOLANA WALLET CHECKER BOT 🔍                      ║
║                                                                ║
║  Real-time monitoring of token purchases                       ║
║  Classifies wallets as: FRESH | SEMI-NEW | OLD                ║
╚══════════════════════════════════════════════════════════════╝

Enter the token address to monitor:
(Example: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC)

Token Address > <paste-token-address-here>

Select monitoring mode:
  1. WebSocket (recommended, real-time)
  2. Polling (fallback, uses more requests)

Mode [1/2] > 1

Starting monitoring for token:
<token-address>

Mode: WebSocket
Threshold: 5 tokens = OLD wallet

Waiting for new transactions...
```

When a new buyer is detected:

```
[14:30:15] NEW BUYER DETECTED
────────────────────────────────────────────────────────────────
Wallet:      7xKXtg2CW87...RVBPu5NV
Status:      █ FRESH █
Unique Tokens: 0 different tokens traded
Total Txns:   3 transactions
First Txn:    2024-01-15 10:30:00
Funded By:    5xPQrR7z...nKLmYZ
SOL Balance:  1.5000 SOL
────────────────────────────────────────────────────────────────
```

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `QUICKNODE_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `QUICKNODE_WSS_URL` | `wss://api.mainnet-beta.solana.com` | Solana WebSocket endpoint |
| `OLD_WALLET_THRESHOLD` | `5` | Number of unique tokens for OLD classification |
| `POLL_INTERVAL` | `5` | Polling interval in seconds (polling mode only) |

## API Notes

### QuickNode (Recommended)
- Higher rate limits
- More reliable WebSocket connections
- Get a free tier at [QuickNode](https://www.quicknode.com/)

### Public Solana RPC
- Free but rate-limited
- WebSocket connections may be less stable
- Good for testing

## How It Works

1. **Transaction Detection**: The bot monitors the specified token address for new transactions
2. **Buyer Identification**: When a transaction is detected, it identifies wallets that increased their token balance (buyers)
3. **Wallet Analysis**: For each buyer, the bot:
   - Fetches the wallet's transaction history
   - Counts unique token mints traded (excluding the current token)
   - Finds the first transaction and funding source
4. **Classification**: Based on unique token count:
   - 0 tokens = FRESH (new wallet)
   - 1-4 tokens = SEMI-NEW
   - 5+ tokens = OLD (experienced trader)

## Troubleshooting

### WebSocket Connection Issues
- Try using polling mode instead (`Mode [1/2] > 2`)
- Check if your RPC endpoint supports WebSocket subscriptions
- Some endpoints may have connection limits

### Rate Limiting
- Switch to QuickNode or another paid RPC provider
- Increase `POLL_INTERVAL` if using polling mode
- The bot includes built-in delays to avoid rate limits

### No Transactions Detected
- Verify the token address is correct
- Check if the token has active trading
- Try with a popular token like USDC to test: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

## License

MIT License - Feel free to use and modify for your needs.
