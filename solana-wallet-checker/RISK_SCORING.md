# Risk Scoring System Documentation

## Overview
The Risk Scoring System is an advanced feature that automatically calculates risk levels for token holders based on multiple behavioral and statistical factors. This helps identify potentially suspicious wallets, coordinated buying groups, and whale activities.

## Risk Calculation Factors

### 1. Token Diversity (0-25 points)
Evaluates the variety of tokens a wallet has traded:
- **25 points**: No trading history (❌ Red flag)
- **20 points**: Only 1-2 different tokens traded (⚠️ High risk)
- **10 points**: 3-5 different tokens traded (⚠️ Moderate risk)
- **0 points**: 6+ different tokens (✅ Normal)

**Why it matters**: Wallets with limited trading history may be:
- Newly created for manipulation
- Single-purpose wallets for coordinated pumps
- Bot-controlled accounts

### 2. Holder Concentration (0-30 points)
Measures the percentage of token supply held:
- **30 points**: ≥10% of supply (🐋 Whale alert)
- **20 points**: 5-9.99% of supply (📊 Significant holder)
- **10 points**: 2-4.99% of supply (📈 Notable holder)
- **0 points**: <2% of supply (✅ Normal)

**Why it matters**: Large holders can:
- Manipulate price through large sells
- Create artificial scarcity
- Control market sentiment

### 3. Coordinated Activity (0-30 points)
Detects wallets with similar trading patterns:
- **30 points**: Group of 3+ wallets with 7+ common tokens (🚨 High coordination)
- **20 points**: Group of 2+ wallets with 5+ common tokens (⚠️ Moderate coordination)
- **10 points**: Group with 3-4 common tokens (ℹ️ Possible coordination)
- **0 points**: No similar patterns detected (✅ Normal)

**Why it matters**: Coordinated wallets indicate:
- Pump and dump groups
- Single entity controlling multiple wallets
- Organized market manipulation

### 4. Suspicious Patterns (0-15 points)
Identifies unusual wallet behaviors:
- **15 points**: Large balance (>1M tokens) with minimal activity (≤1 token traded)
- **10 points**: Small balance (<100 tokens) with excessive activity (≥10 tokens traded)
- **0 points**: Normal balance-to-activity ratio

**Why it matters**: These patterns suggest:
- Accumulation wallets for manipulation
- Money laundering activities
- Bot-driven trading operations

## Risk Levels

### 🔴 CRITICAL (70-100 points)
**Status**: High risk of manipulation/coordination
**Recommended Action**: Extreme caution, likely malicious actor
**Common Characteristics**:
- Whale holder (>10% supply)
- No or minimal trading history
- Part of coordinated group with many shared tokens

### 🟠 HIGH (50-69 points)
**Status**: Significant risk indicators present
**Recommended Action**: Exercise caution, monitor closely
**Common Characteristics**:
- Significant holder (5-10% supply)
- Limited trading diversity
- May be part of coordinated activities

### 🟡 MEDIUM (30-49 points)
**Status**: Moderate risk factors detected
**Recommended Action**: Normal vigilance recommended
**Common Characteristics**:
- Notable holder (2-5% supply)
- Some trading history
- Minor coordination signals

### 🟢 LOW (0-29 points)
**Status**: Normal holder behavior
**Recommended Action**: Minimal concern
**Common Characteristics**:
- Small to medium holder (<2% supply)
- Diverse trading history
- No coordination detected

## Output Format

### Risk Summary
```
📊 RISK SUMMARY:
   Critical Risk: X holders
   High Risk: X holders
   Medium Risk: X holders
   Low Risk: X holders
```

### Individual Holder Analysis
```
#1 🔴 CRITICAL (Score: 70/100) ─────────────────────
    High risk of manipulation/coordination
    Wallet:         AjBjHWzSUsLkYFHfN8GF9zdocnzcy7ugq26qaiQjoSaH
    Balance:        88,785,694.91 tokens (37.59% of top 9)
    First Purchase: 2026-01-28 10:30:45
    Trading History: 0 different tokens traded
    ⚠️  Risk Factors:
       • ❌ No trading history (25pts)
       • 🐋 Large holder: 37.59% of supply (30pts)
       • 🔍 Large holder with minimal trading activity (15pts)
```

Holders are automatically sorted by risk score (highest risk first) for easy identification of the most concerning wallets.

## Use Cases

### 1. Pre-Investment Analysis
Before investing in a token, check holder risk scores to:
- Identify pump and dump potential
- Assess whale concentration risk
- Detect coordinated buyer groups

### 2. Post-Purchase Monitoring
After buying a token, monitor for:
- New high-risk holders entering
- Changes in whale concentration
- Emergence of coordinated groups

### 3. Token Health Assessment
Evaluate overall token quality by:
- Counting critical/high-risk holders
- Checking holder distribution
- Analyzing coordination patterns

### 4. Red Flag Detection
Immediate concern if you see:
- Multiple 🔴 CRITICAL holders
- High coordination scores (30pts)
- Large whale concentration (>50% in top holders)

## Technical Implementation

### Calculation Method
```python
risk_score = (
    token_diversity_score +    # 0-25 points
    concentration_score +      # 0-30 points
    coordination_score +       # 0-30 points
    suspicious_pattern_score   # 0-15 points
)
# Maximum possible: 100 points
```

### Data Sources
- **Token History**: From wallet transaction signatures (getSignaturesForAddress)
- **Holder Balances**: From token account data (getTokenLargestAccounts)
- **Similarity Analysis**: Computed from trading pattern comparisons

### Performance
- Analysis time: ~30-90 seconds for 10-15 holders
- Memory efficient: Processes one wallet at a time
- Rate limit friendly: Uses delays between RPC calls

## Limitations

1. **Historical Data**: Only analyzes available on-chain transaction history
2. **Off-Chain Activities**: Cannot detect coordination happening outside the blockchain
3. **New Wallets**: May flag legitimate new wallets as risky
4. **CEX Wallets**: May incorrectly score centralized exchange wallets

## Best Practices

1. **Combine with Other Analysis**: Don't rely solely on risk scores
2. **Context Matters**: Consider token age and market conditions
3. **Multiple Checks**: Run analysis at different times to track changes
4. **Cross-Reference**: Compare with community sentiment and project updates
5. **Document Results**: Save analysis reports for future reference

## Example Scenarios

### Scenario 1: Healthy Token
```
Critical: 0 holders
High: 1 holder (team wallet)
Medium: 3 holders
Low: 6 holders
```
**Assessment**: Good distribution, minimal risk

### Scenario 2: Pump Risk
```
Critical: 5 holders
High: 4 holders
Medium: 1 holder
Low: 0 holders
```
**Assessment**: High manipulation risk, avoid or exit

### Scenario 3: Whale Dominated
```
Critical: 2 holders (40%+ supply)
High: 1 holder
Medium: 4 holders
Low: 3 holders
```
**Assessment**: Whale concentration risk, price manipulation potential

## Future Enhancements

Potential improvements for future versions:
1. Machine learning-based risk prediction
2. Historical risk trend analysis
3. Cross-token pattern detection
4. Real-time risk alerts
5. Integration with DEX liquidity data
6. Wallet reputation scoring
7. Advanced coordination detection algorithms

## Support

For questions or issues with the Risk Scoring System:
1. Check this documentation
2. Review IMPLEMENTATION_SUMMARY.md for technical details
3. Examine test_risk_scoring.py for usage examples
4. Create an issue in the repository

---

**Last Updated**: January 29, 2026
**Version**: 1.0.0
**Author**: GitHub Copilot
