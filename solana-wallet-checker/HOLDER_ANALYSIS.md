# Top Holders Analysis Feature 🆕

## Overview
Fitur baru untuk menganalisis 30 holder terbesar dari sebuah token Solana, lengkap dengan jumlah token yang dipegang dan waktu pembelian pertama mereka.

## How to Use

### 1. Run Program
```bash
cd solana-wallet-checker
python main.py
```

### 2. Select Option 3
```
Select Mode [1/2/3] > 3
```

### 3. Input Token Address
Masukkan address token Solana yang ingin dianalisis.

## Features

### ✅ Top 30 Holders
- Menampilkan 30 wallet dengan balance terbesar
- Sorted dari balance tertinggi ke terendah

### ✅ Balance Information
- Jumlah token yang dipegang
- Persentase dari total top 30 holders

### ✅ Purchase Time Tracking
- Waktu pembelian pertama (first purchase)
- Format: `YYYY-MM-DD HH:MM:SS`

### ✅ Liquidity Pool Filtering
- Otomatis filter liquidity pools
- Hanya menampilkan wallet personal/trading
- Filter program IDs:
  - Raydium AMM/V4/CLMM
  - Orca Whirlpool/V1/V2

### ✅ Export to File
- Option untuk save hasil ke file `.txt`
- Format filename: `holders_<token>_<timestamp>.txt`

## Output Example

```
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
```

## Technical Details

### Module: `holder_analyzer.py`

**Class:** `HolderAnalyzer`

**Methods:**
- `get_token_holders(token_mint, limit=30)` - Fetch top holders
- `format_holders_output(holders, token_mint)` - Format output

**Process:**
1. Fetch all token accounts via `getProgramAccounts`
2. Parse and extract owner + balance
3. Filter out liquidity pools
4. Sort by balance (descending)
5. Get first purchase time for each holder
6. Format and display

### Performance
- Fast with QuickNode RPC (recommended)
- May take 30-60 seconds for 30 wallets (fetching transaction history)
- Uses parallel async requests for efficiency

## Use Cases

### 1. Whale Detection
Identify large token holders (potential market movers)

### 2. Distribution Analysis
See how concentrated token ownership is

### 3. Early Buyer Tracking
Find wallets that bought early (oldest purchase times)

### 4. Trading Strategy
Monitor top holder behavior for trading signals

## Tips

✅ **Use QuickNode RPC** for faster analysis  
✅ **Save results** for comparison over time  
✅ **Check purchase times** to identify early buyers  
✅ **Monitor balance changes** by running periodically  

## Troubleshooting

**Slow Analysis:**
- Normal for public RPC (rate limits)
- Upgrade to QuickNode for faster results

**No Holders Found:**
- Verify token address is correct
- Check if token has any holders

**Unknown Purchase Time:**
- Wallet has >1000 transactions
- Transaction too old (not indexed)

## Files Created

### holder_analyzer.py
Core analysis module with HolderAnalyzer class.

### Output Files (Optional)
Format: `holders_<token_short>_<YYYYMMDD_HHMMSS>.txt`
Example: `holders_HJU81emP_20260129_143000.txt`

## Status
🟢 **READY** - Feature fully implemented and tested!
