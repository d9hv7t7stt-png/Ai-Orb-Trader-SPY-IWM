# Ai-Orb-Trader-SPY-IWM
V4

## Position sizing (paper / challenge accounts)
- Never more than **10% of the account in options at once**.
- Each ORB entry: **0DTE ATM leg = 4%** of balance + **1DTE expected-move leg = 4%**.
- **Retest add** (once, 0DTE leg only) = **2%**.
- Contracts per leg = floor(pct × balance ÷ (premium × 100)); a leg under 1 contract is skipped.
- Hard cap: a leg or add is reduced/skipped so total open exposure (cost of open contracts) stays ≤ 10% of balance (and ≤ `maxRiskDollars` where set, e.g. SPX $10k).

## Entry cutoff
- No new trades (entries, flips into a new position, retest adds) at or after **3:55 PM ET** on any account (paper and live). Stops, trims, the expected-move exit and the 3:45 PM ET half sell keep running.
