# Trading Pattern Similarity Analysis Feature 🆕

## Overview
Fitur tambahan untuk **Top Token Holders Analysis** yang menganalisis similarity trading patterns antar holders untuk mendeteksi:
- 🎯 Wallet yang dikontrol oleh orang yang sama
- 🤝 Coordinated buyers / Pump groups
- 📊 Similar trading behavior

## How It Works

### 1. **Token History Analysis**
Untuk setiap holder, program:
- Fetch 50 transaksi terakhir
- Extract semua token yang pernah di-trade
- Exclude token yang sedang dianalisis

### 2. **Pattern Comparison**
Membandingkan history token antar holders:
- Cari common tokens (minimal 3 token sama)
- Hitung similarity score
- Identifikasi trading patterns

### 3. **Group Detection**
Kelompokkan wallets dengan pattern similarity:
- Connected component analysis
- Find wallet clusters
- Identify coordinated groups

## Usage

### Run Analysis
```bash
python main.py
# Select: 3 (Analyze Top Token Holders)
# Enter token address
# When prompted: "Analyze trading pattern similarities? [y/N]"
# Type: y
```

### Output Example

```
================================================================================
TOP 30 TOKEN HOLDERS
Token: HJU81emP8GftNsQQwqbUGgDVH4pygpvskuVN2tfSpump
================================================================================

# 1 ─────────────────────────────────────────────────────────────
    Wallet:         7xKXtg2CW87d4MWgUgqo8RVBPu5NVkT9xY2sP3QrM8Kz
    Balance:        1,234,567.890000 tokens (15.25% of top 30)
    First Purchase: 2026-01-28 14:30:15
    Trading History: 25 different tokens traded

# 2 ─────────────────────────────────────────────────────────────
    Wallet:         5YzP9Rmk3NuF6TqC8VwXRdP7nKLmYZkT9xY2sP3QrM8K
    Balance:        987,654.321000 tokens (12.19% of top 30)
    First Purchase: 2026-01-28 15:45:22
    Trading History: 28 different tokens traded

...

================================================================================
Total Balance (Top 30): 8,098,765.432100 tokens
================================================================================

🔍 ============================================================================
TRADING PATTERN SIMILARITY ANALYSIS
================================================================================

Found 2 group(s) of wallets with similar trading patterns

📊 GROUP #1 - 5 Wallets
────────────────────────────────────────────────────────────────────────────────
Common Tokens Traded: 15 tokens

Wallets in this group:
  • 7xKXtg2CW87d4MWgUgqo8RVBPu5NVkT9xY2sP3QrM8Kz
    Balance: 1,234,567.89 tokens
  • 5YzP9Rmk3NuF6TqC8VwXRdP7nKLmYZkT9xY2sP3QrM8K
    Balance: 987,654.32 tokens
  • 3aBC8dEfG2hIjK4lMnO6pQrS8tUvW0xYz2A4B6C8D
    Balance: 750,123.45 tokens
  • 9mNoPqR3sTuVw5XyZ7aBC9dEfG1hIjK3lMnO5pQr
    Balance: 650,987.65 tokens
  • 2kLmN4oPq6RsT8uVw0XyZ2aBC4dEfG6hIjK8lMn
    Balance: 580,456.78 tokens

Sample Common Tokens (showing up to 10):
  • EPjFWdd5AufqSSqeM2q...1xzybapC8G4
  • So11111111111111111...1111111111112
  • Es9vMFrzaCERmJfrF4H...2Wc18xF7jvpx
  • 4k3Dyjzvzp8eMZWUXb...PwDa3hny4QLEc
  • 7GCihgDB8fe6KNjn2M...UqCGjHdowYDh
  • mSoLzYCxHdYgdzU16g...5Z5FPz4S5W2
  • BRjpCHtyQLNCo8gqRU...YF6fceVVSBWE
  • DezXAZ8z7PnrnRJjz3...DYnSTxtmstSa
  • 5oVNBeEEQvYi1cX3ir...3F7aUdufKgCW
  • 3NZ9JMVBmGAqocybic...dkTCiQrdWGC

⚠️  Note: These wallets may be controlled by the same entity
    or coordinated buyers (pump groups).

📊 GROUP #2 - 3 Wallets
────────────────────────────────────────────────────────────────────────────────
Common Tokens Traded: 8 tokens

Wallets in this group:
  • 8xYzAb3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Y
    Balance: 450,789.12 tokens
  • 6vWxY9zAb1Cd3Ef5Gh7Ij9Kl1Mn3Op5Qr7St9Uv
    Balance: 380,654.32 tokens
  • 4tUv7Wx9Yz1Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9
    Balance: 320,987.65 tokens

Sample Common Tokens (showing up to 10):
  • EPjFWdd5AufqSSqeM2q...1xzybapC8G4
  • So11111111111111111...1111111111112
  • Es9vMFrzaCERmJfrF4H...2Wc18xF7jvpx
  • 4k3Dyjzvzp8eMZWUXb...PwDa3hny4QLEc
  • 7GCihgDB8fe6KNjn2M...UqCGjHdowYDh
  • mSoLzYCxHdYgdzU16g...5Z5FPz4S5W2
  • BRjpCHtyQLNCo8gqRU...YF6fceVVSBWE
  • DezXAZ8z7PnrnRJjz3...DYnSTxtmstSa

⚠️  Note: These wallets may be controlled by the same entity
    or coordinated buyers (pump groups).

================================================================================
```

## Key Features

### ✅ Trading History Tracking
- Shows how many different tokens each holder has traded
- Helpful to identify experienced vs new traders

### ✅ Common Token Detection
- Finds holders who traded the same tokens
- Minimum threshold: 3 common tokens

### ✅ Wallet Grouping
- Groups wallets with similar patterns
- Uses graph-based clustering algorithm
- Identifies coordinated behavior

### ✅ Visual Grouping
- Clear group separation
- Shows wallet addresses and balances
- Lists sample common tokens

### ✅ Warning Messages
- Alerts about potential coordinated activity
- Helps identify pump groups or multi-wallet holders

## Use Cases

### 1. 🕵️ Pump Group Detection
Identify wallets working together to pump a token.

### 2. 🎯 Multi-Wallet Detection
Find if large holders use multiple wallets.

### 3. 📊 Trading Pattern Analysis
Understand holder behavior and strategy.

### 4. ⚠️ Risk Assessment
Higher risk if top holders are coordinated.

### 5. 💡 Investment Decisions
Avoid tokens with suspicious holder patterns.

## Algorithm Details

### Token History Extraction
```python
# For each holder:
1. Fetch last 50 transactions
2. Parse postTokenBalances
3. Extract unique token mints
4. Store in set()
```

### Similarity Calculation
```python
# Compare holders pairwise:
common_tokens = holder1_tokens ∩ holder2_tokens

if len(common_tokens) >= 3:
    # Mark as similar
    add_to_patterns()
```

### Group Detection (Graph Algorithm)
```python
# Build adjacency graph:
wallet_connections = {
    wallet1: [wallet2, wallet3],
    wallet2: [wallet1, wallet4],
    ...
}

# Find connected components (BFS):
for each wallet:
    if not visited:
        find_all_connected()  # Forms a group
```

## Performance

### Time Complexity
- **Token History**: O(n × m) where n=holders, m=transactions/holder
- **Comparison**: O(n²) for pairwise comparison
- **Grouping**: O(n + e) where e=edges (BFS)

### Typical Duration
- **Without analysis**: ~10-30 seconds (basic holders only)
- **With analysis**: ~30-90 seconds (includes pattern matching)
- **With QuickNode**: Faster (better rate limits)

### RPC Calls
- Basic holders: ~30-60 calls
- With similarity: ~1500-2000 additional calls (50 tx × 30 holders)

## Configuration

### Adjustable Parameters

```python
# In _get_wallet_token_history():
limit: int = 50  # Number of transactions to check

# In analyze_holder_similarities():
if len(common_tokens) >= 3:  # Minimum common tokens threshold
```

## Tips

### ✅ Best Practices
1. Use **QuickNode RPC** for faster analysis
2. Run similarity analysis **optionally** (takes longer)
3. Save results to file for comparison over time
4. Focus on **larger groups** (more significant)

### ⚠️ Limitations
1. Only checks last 50 transactions per wallet
2. Very old transactions may not be included
3. Common tokens like SOL, USDC are expected
4. May have false positives for popular tokens

### 🎯 Interpretation
- **Large groups (5+ wallets)**: Likely coordinated
- **Few common tokens (3-5)**: Could be coincidence
- **Many common tokens (10+)**: High probability same owner
- **Similar balances**: More suspicious

## Technical Implementation

### New Methods in `holder_analyzer.py`:

1. **`_get_wallet_token_history()`**
   - Fetches trading history for a wallet
   - Returns set of token mints

2. **`analyze_holder_similarities()`**
   - Main similarity analysis function
   - Compares all holder pairs
   - Returns groups and patterns

3. **`_group_similar_wallets()`**
   - Graph-based clustering
   - BFS for connected components
   - Returns grouped wallets

### Updated Methods:

1. **`format_holders_output()`**
   - Added `similarity_analysis` parameter
   - Shows trading history count
   - Displays similarity groups

### Main Flow:

```python
# In main.py:
holders = await analyzer.get_token_holders()

# Optional similarity analysis
if user_wants_analysis:
    similarity = await analyzer.analyze_holder_similarities()
    
# Format output with similarity data
output = analyzer.format_holders_output(holders, token, similarity)
```

## Status
🟢 **COMPLETE** - Feature fully implemented and tested!

## Files Modified
- `holder_analyzer.py` - Added 3 new methods
- `main.py` - Updated analyze_top_holders()
- Output formatting enhanced

---

**Feature Added:** January 29, 2026  
**Module:** Trading Pattern Similarity Analysis  
**Lines Added:** ~200+ lines
