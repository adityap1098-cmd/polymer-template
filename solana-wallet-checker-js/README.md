# 🔍 Solana Wallet Checker Bot

Real-time token buyer classification & holder risk analysis tool for Solana. Detects sybil clusters, coordinated wallets, sniper bots, and suspicious holder patterns using on-chain data.

> Inspired by [Bubblemaps](https://bubblemaps.io/), [Arkham Intelligence](https://www.arkhamintelligence.com/), [GMGN](https://gmgn.ai/), and [RugCheck](https://rugcheck.xyz/).

## ✨ Features

### 🎯 Analysis Methods

| Method | Description |
|---|---|
| **Jaccard Similarity** | Detect wallets trading the same tokens (Near Identical ≥0.8, High ≥0.4, Moderate) |
| **Gini Coefficient** | Measure holder concentration / distribution fairness |
| **Funding Chain** | Trace funding origins up to 2 hops — find sybil clusters sharing the same funder |
| **Buy-Timing Correlation** | Detect coordinated purchases within short time windows |
| **Wallet Profiling** | Classify wallets: `ORGANIC`, `SNIPER_BOT`, `COPY_TRADER`, `DORMANT`, `FRESH_FUNDED` |
| **7-Factor Risk Scoring** | Score each holder 0–100 based on multiple signals |

### 📊 Risk Score Factors

1. **Token diversity** — How many unique tokens the wallet holds
2. **Supply concentration** — Percentage of token supply held
3. **Wallet age** — How old the wallet is
4. **Trading similarity** — Jaccard coefficient with other holders
5. **Funding cluster** — Shared funders with other holders
6. **Whale behavior** — Large holders with no trading history
7. **Timing pattern** — Coordinated buy timing

### 🏦 Known Entity Filtering

Automatically filters out known entities to reduce false positives:
- **Exchanges** — Binance, Coinbase, Kraken, OKX, Bybit, KuCoin, Gate.io, Bitget, MEXC, ChangeNow
- **DEX/Liquidity** — Raydium, Orca, Jupiter, Pump.fun, Meteora, Phoenix, OpenBook, Marinade
- **Bots** — Known volume bots, MEV bots, sniper bots
- **Universal tokens** — wSOL, USDC, USDT, BONK, JUP excluded from similarity analysis

### 🖥️ 4 Operating Modes

| Mode | Description |
|---|---|
| **1. WebSocket Monitor** | Real-time transaction monitoring via WebSocket subscription |
| **2. Polling Monitor** | Real-time monitoring with polling fallback |
| **3. Deep Holder Analysis** | Comprehensive token holder risk analysis (Quick/Standard/Deep) |
| **4. CSV Import** | Import & analyze from Solscan CSV export (100+ holders) |

## 🚀 Getting Started

### Prerequisites

- **Node.js** v18+ 
- **Solana RPC endpoint** — [QuickNode](https://www.quicknode.com/) recommended (free tier: ~15 req/sec)

### Installation

```bash
cd solana-wallet-checker-js
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env` with your RPC credentials:

```dotenv
# Solana RPC endpoint (QuickNode recommended)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WSS_URL=wss://api.mainnet-beta.solana.com

# Wallet classification threshold
OLD_WALLET_THRESHOLD=5

# Polling interval in seconds
POLL_INTERVAL=5
```

> ⚠️ Public RPC (`api.mainnet-beta.solana.com`) has strict rate limits (~100 req/10s). For production use, get a dedicated RPC from QuickNode, Helius, or Alchemy.

### Run

```bash
npm start
```

You'll see an interactive menu:

```
╔══════════════════════════════════════════════════════════════╗
║  🔍 SOLANA WALLET CHECKER BOT v2.0                          ║
╠══════════════════════════════════════════════════════════════╣
║  1. Monitor real-time (WebSocket)                            ║
║  2. Monitor real-time (Polling)                              ║
║  3. Deep Token Holder Analysis                               ║
║  4. Import & Analyze dari CSV                                ║
║  0. Exit                                                     ║
╚══════════════════════════════════════════════════════════════╝
```

### Run Tests

```bash
npm test
```

## 📋 Usage Guide

### Mode 3: Deep Token Holder Analysis

The primary analysis mode. Enter a token mint address and choose analysis depth:

| Depth | Holders | Features |
|---|---|---|
| **Quick** | Top 10 | Basic risk scoring + holder overview |
| **Standard** | Top 20 | + Jaccard similarity + funding chains |
| **Deep** | Top 50 | + Full sybil detection + timing correlation |

**Output includes:**

- **Quick Verdict** — Overall risk rating with actionable summary
- **Risk Distribution** — Count of Critical/High/Medium/Low risk holders
- **Top Risk Holders** — Detailed breakdown for high-risk wallets (score ≥ 35)
- **Compact Table** — Low-risk holders in condensed format
- **Cluster Analysis** — Sybil clusters with % of supply controlled
- **Trading Similarity** — Jaccard groups with severity labels
- **Funding Chain** — Multi-hop funding origins with entity labels

Results are saved to `holders_<TOKEN>_<TIMESTAMP>.txt`.

### Mode 4: CSV Import

Import Solscan CSV exports for tokens with 100+ holders:

```bash
# Export from Solscan → Holders tab → Download CSV
# Then select Mode 4 and provide the CSV file path
```

## 📄 Example Output

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ⚡ QUICK VERDICT                                                            │
├──────────────────────────────────────────────────────────────────────────────┤
│  Overall:   🟡 MODERATE RISK (50/100)
│  Holders:   20 analyzed
│  Gini:      0.384 — well distributed
│  Top 5:     54.93% of supply
│  Fresh:     20/20 wallets ≤7 days old (100%)
│  Sybil:     2 cluster(s) — 4 wallets control 13.3%
│  Similar:   1 group(s) — 7 wallets share trading patterns (23.5%)
│
│  📋 ⚠️  MODERATE — Ada indikasi risiko. Perlu investigasi lebih lanjut.
└──────────────────────────────────────────────────────────────────────────────┘

📊 Risk Distribution: 🔴 0 Critical | 🟠 4 High | 🟡 15 Medium | 🟢 1 Low
```

**Individual holder detail:**

```
  # 1 🟠 HIGH — Score: 60/100
  4t3MDnBzjVD221wqCGLDs2kmfeDAgy2pdixxxmJuAgeV
  150,799,424 tokens (36.55%) | Age: 1d | Tokens: 0 (excl. universal)
    → ❌ No trading history (15pts)
    → 🐋 Whale: 36.55% of supply (20pts)
    → 🆕 Brand new wallet: 1 day(s) old (15pts)
    → 🔍 Whale with no trading history (10pts)
```

**Sybil cluster detection:**

```
  🚨 SYBIL CLUSTERS — 2 detected (13.3% of supply)

  Cluster #1 — 2 wallets — 7.5% supply — Funder: po27...FoB 🏦 🤖 Sniper MEV Bot
    5qW7io...pBb  (4.6%)
    G1E1L7...oBJ  (2.9%)
```

## 🏗️ Architecture

```
src/
├── main.js               # CLI entry point & orchestration
├── holderAnalyzer.js      # Core analysis: holders, risk scoring, similarity
├── walletAnalyzer.js      # Wallet classification & profiling
├── fundingAnalyzer.js     # Funding chain tracing & sybil detection
├── transactionMonitor.js  # Real-time WebSocket/polling monitor
├── knownEntities.js       # Exchange, DEX, bot database
├── csvImporter.js         # Solscan CSV import
├── rateLimiter.js         # Token bucket rate limiter + RPC client
└── test.js                # Test suite (62 tests, 17 suites)
```

### Key Classes

| Class | File | Purpose |
|---|---|---|
| `HolderAnalyzer` | holderAnalyzer.js | Fetch holders, Jaccard similarity, Gini, risk scoring |
| `WalletAnalyzer` | walletAnalyzer.js | Wallet age, token history, profiling |
| `FundingAnalyzer` | fundingAnalyzer.js | Funding chain tracing, sybil clusters |
| `TransactionMonitor` | transactionMonitor.js | WebSocket + polling real-time monitor |
| `RateLimitedRPC` | rateLimiter.js | Custom JSON-RPC with token bucket + retry |
| `CSVImporter` | csvImporter.js | Parse Solscan CSV exports |

## ⚡ Rate Limiting

Built-in rate limiting prevents 429 errors from RPC providers:

- **Token bucket** algorithm with configurable requests/second
- **Adaptive backoff** — automatically slows down on 429 responses
- **Gradual recovery** — ramps back up after successful requests
- **Default: 12 req/sec** (80% headroom for QuickNode free tier at 15/s)
- **Auto-retry** — up to 3 retries with exponential backoff

## 🧪 Testing

```bash
npm test
```

62 tests across 17 suites covering:
- Gini coefficient calculations
- Jaccard similarity
- Risk scoring edge cases
- Known entity filtering
- Funding chain detection
- Output formatting
- CSV import parsing
- Rate limiter behavior

## 📦 Dependencies

| Package | Purpose |
|---|---|
| `@solana/web3.js` | Solana blockchain interaction |
| `chalk` | Terminal colors |
| `inquirer` | Interactive CLI prompts |
| `dotenv` | Environment variable loading |
| `csv-parse` | CSV file parsing |
| `bs58` | Base58 encoding/decoding |
| `ws` | WebSocket client |

## 📝 Risk Score Interpretation

| Score | Level | Meaning |
|---|---|---|
| 75–100 | 🔴 Critical | Almost certainly suspicious — likely sybil/bot |
| 50–74 | 🟠 High | Strong risk indicators — investigate further |
| 35–49 | 🟡 Medium | Some risk signals — monitor closely |
| 0–34 | 🟢 Low | Appears organic — normal trading behavior |

## ⚠️ Verdict Levels

| Risk | Verdict |
|---|---|
| 🟢 ≤ 30 | **AMAN** — Holder terlihat organik dan terdistribusi baik |
| 🟡 31–60 | **MODERATE** — Ada indikasi risiko. Perlu investigasi lebih lanjut |
| 🔴 > 60 | **BAHAYA** — Sangat mencurigakan. Kemungkinan besar ada sybil/manipulasi |

## 📄 License

MIT
