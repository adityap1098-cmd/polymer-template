# Solana Wallet Checker Bot 🔍

A Python bot for monitoring Solana token transactions in real-time and classifying wallets based on their transaction history.

## Features

### 1. **Real-time Purchase Monitoring**
- Monitors token purchases via WebSocket or polling
- **Wallet Classification**:
  - 🟢 **FRESH**: Wallet has no other token transactions (first-time buyer)
  - 🟡 **SEMI-NEW**: Wallet has less than 5 different token transactions
  - 🔴 **OLD**: Wallet has 5 or more different token transactions
- **Wallet Analysis**:
  - When the wallet was created (first transaction time)
  - Initial funding source (who sent SOL to this wallet)
  - Current SOL balance
  - Total transaction count

### 2. **Top Holders Analysis** 🆕
- Analyze top 30 token holders
- Shows holder balance and percentage
- Tracks first purchase time for each holder
- Filters out liquidity pools automatically
- **Risk Scoring System** 🔥🆕
  - Automatic risk calculation (0-100 points)
  - Risk levels: 🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM, 🟢 LOW
  - Multi-factor analysis:
    - Token diversity (trading history breadth)
    - Holder concentration (% of supply held)
    - Coordinated activity detection
    - Suspicious pattern identification
  - Sorts holders by risk score (highest risk first)
  - Detailed risk factor breakdown for each holder
- **Trading Pattern Similarity Analysis**
  - Detect wallets with similar trading history
  - Identify coordinated buyers / pump groups
  - Find wallets potentially controlled by same entity
  - Group holders by trading patterns
- Export results to text file

## Requirements

- Python 3.8+
- Solana RPC endpoint (QuickNode recommended for production)
  - ⚠️ **Public RPC has strict rate limits** (~100 requests/10 seconds)
  - ✅ **Free QuickNode recommended** for reliable monitoring

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
   SOLANA_RPC_URL=https://your-endpoint.solana-mainnet.quiknode.pro/your-api-key/
   SOLANA_WSS_URL=wss://your-endpoint.solana-mainnet.quiknode.pro/your-api-key/
   ```

## Usage

Run the bot:
```bash
python main.py
```

The bot will show you a main menu with 4 options:

### Option 1: Monitor Real-time Purchases (WebSocket)
Real-time monitoring using WebSocket for instant transaction detection.

### Option 2: Monitor Real-time Purchases (Polling)
Slower but more compatible monitoring using RPC polling.

### Option 3: Analyze Top Token Holders
Analyzes and displays the top holders of a token directly from RPC:
- Wallet address
- Token balance and percentage of top holders
- First purchase timestamp
- **Risk assessment with detailed scoring** 🔥
- Trading pattern similarity analysis
- Option to export to text file

**⚠️ Important Note**: Solana RPC API typically returns ~15-20 largest token accounts by default. This is a Solana blockchain limitation, not a limitation of our bot. Premium RPC providers may offer higher limits.

### Option 4: Import & Analyze from CSV 🔥🆕
Import holder data from Solscan CSV export and analyze **100+ holders**:
- **Bypass RPC limitations** - analyze as many holders as you want!
- Import CSV from Solscan token holder export
- Full risk scoring for all imported holders
- Trading pattern similarity analysis (optional)
- Comprehensive risk reports
- Export analysis results

**CSV Format**: Standard Solscan export with columns: `Rank, Address, Quantity, Percentage`

**How to get CSV from Solscan:**
1. Visit solscan.io/token/[your-token-address]
2. Go to "Holders" tab
3. Click "Export" button
4. Save CSV file
5. Use Option 4 to import and analyze!

**Supported CSV Format:**
- Standard Solscan export: `Account, Token Acct, Quantity, Percentage`
- Generic formats with columns: `Address/Wallet/Owner, Balance/Amount/Quantity, Percentage`
- See [CSV_FORMAT_GUIDE.md](CSV_FORMAT_GUIDE.md) for detailed format documentation

**Risk Scoring Features:**
- **4-Factor Risk Analysis**:
  1. Token Diversity (0-25 pts): Breadth of trading history
  2. Holder Concentration (0-30 pts): % of supply controlled
  3. Coordinated Activity (0-30 pts): Similar trading patterns with others
  4. Suspicious Patterns (0-15 pts): Unusual behavior detection
  
- **Risk Levels**:
  - 🔴 **CRITICAL** (70-100 pts): High manipulation risk
  - 🟠 **HIGH** (50-69 pts): Significant risk indicators
  - 🟡 **MEDIUM** (30-49 pts): Moderate risk factors
  - 🟢 **LOW** (0-29 pts): Normal holder behavior

- **Output includes**:
  - Risk summary showing distribution of risk levels
  - Holders sorted by risk score (highest first)
  - Detailed risk factors for each holder
  - Identification of coordinated wallet groups

For detailed documentation about the Risk Scoring System, see [RISK_SCORING.md](RISK_SCORING.md).

The bot will prompt you for:
1. **Operation Mode**: Choose between monitoring (1/2) or holder analysis (3)
2. **Token Address**: The Solana token mint address

### Example Session - Real-time Monitoring

```
╔══════════════════════════════════════════════════════════════╗
║          🔍 SOLANA WALLET CHECKER BOT 🔍                      ║
║                                                                ║
║  Real-time monitoring of token purchases                       ║
║  Classifies wallets as: FRESH | SEMI-NEW | OLD                ║
╚══════════════════════════════════════════════════════════════╝

Select operation mode:
  1. Monitor Real-time Token Purchases (WebSocket/Polling)
  2. Monitor Real-time Token Purchases (Polling only)
  3. Analyze Top Token Holders

Select Mode [1/2/3] > 1

Enter the token address:
(Example: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC)

Token Address > <paste-token-address-here>

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

### Example Session - Top Holders Analysis

```
Select Mode [1/2/3] > 3

Enter the token address:
Token Address > HJU81emP8GftNsQQwqbUGgDVH4pygpvskuVN2tfSpump

🔍 Analyzing Top Token Holders...

Fetching token accounts for HJU81emP8GftNsQQwqbUGgDVH4pygpvskuVN2tfSpump...
Found 1247 token accounts
Analyzing top 30 holders...

================================================================================
TOP 30 TOKEN HOLDERS
Token: HJU81emP8GftNsQQwqbUGgDVH4pygpvskuVN2tfSpump
================================================================================

# 1 ─────────────────────────────────────────────────────────────
    Wallet:        7xKXtg2CW87d4MWgUgqo8RVBPu5NVkT9xY2sP3QrM8Kz
    Balance:       1,234,567.890000 tokens (15.25% of top 30)
    First Purchase: 2026-01-28 14:30:15

# 2 ─────────────────────────────────────────────────────────────
    Wallet:        5YzP9Rmk3NuF6TqC8VwXRdP7nKLmYZkT9xY2sP3QrM8K
    Balance:       987,654.321000 tokens (12.19% of top 30)
    First Purchase: 2026-01-28 15:45:22

...

================================================================================
Total Balance (Top 30): 8,098,765.432100 tokens
================================================================================

Save to file? [y/N] > y
✅ Saved to holders_HJU81emP_20260129_143000.txt
```


## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `SOLANA_WSS_URL` | `wss://api.mainnet-beta.solana.com` | Solana WebSocket endpoint |
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

### ⚠️ Error: 429 Too Many Requests

**Symptom:**
```
Error processing tx: RPC Error: {'code': 429, 'message': 'Too many requests for a specific RPC call'}
```

**Cause:** Public Solana RPC has strict rate limits (~100 requests per 10 seconds)

**Solutions:**

1. **Use QuickNode (RECOMMENDED - Free Tier Available):**
   ```bash
   # Get free endpoint at https://www.quicknode.com/
   # Update .env file:
   SOLANA_RPC_URL=https://your-endpoint.solana-mainnet.quiknode.pro/your-key/
   SOLANA_WSS_URL=wss://your-endpoint.solana-mainnet.quiknode.pro/your-key/
   ```

2. **Use Polling Mode (Slower but More Stable):**
   - Select option `2` when prompted for monitoring mode
   - Increase `POLL_INTERVAL` in `.env` to reduce requests

3. **Code Already Has Rate Limiting:**
   - The bot now includes automatic retry logic
   - Adds delays between RPC calls
   - Should work better with public RPC, but paid endpoint recommended

### WebSocket Connection Issues
- Try using polling mode instead (`Mode [1/2] > 2`)
- Check if your RPC endpoint supports WebSocket subscriptions
- Some endpoints may have connection limits

### Rate Limiting (General)
- Switch to QuickNode or another paid RPC provider
- Increase `POLL_INTERVAL` if using polling mode
- The bot includes built-in delays to avoid rate limits

### No Transactions Detected
- Verify the token address is correct
- Check if the token has active trading
- Try with a popular token like USDC to test: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

## License

MIT License - Feel free to use and modify for your needs.
