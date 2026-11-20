/**
 * Compute an opportunity score (0-100) that rewards early, pre-consensus signals.
 *
 * Unlike aiScore (which measures signal confidence / documentation quality),
 * opportunityScore is designed to correlate with actual returns: low-consensus,
 * novel, fast-moving tickers near 52-week lows score highest.
 *
 * PR 1-0 (2026-11-20, scope decisions, see scripts/backtesting-experiments.md #26):
 * every market-cap term is removed (the microcap tiers +6 to +15 below $2B and,
 * per Chris, the large-cap penalties -12 at $10B+ and -20 at $50B+), as is the
 * NasdaqCM/AMEX penny bonus (+8). An ATR% volatility term (0 to +15) takes their
 * place. Scoring now targets the liquid, volatile universe.
 */

interface OpportunityScoreInput {
  aiScore: number;
  firstSeenDaysAgo: number | null; // null = truly novel
  priorAppearances: number;
  avgVelocity: number;
  price: number | null | undefined;
  /** Not scored since PR 1-0; kept so callers and stored inputs stay unchanged. */
  marketCap: number | null | undefined;
  wk52Lo: number | null | undefined;
  wk52Hi: number | null | undefined;
  medianSignalAgeHrs: number | null | undefined;
  shortFloat: number | null | undefined;
  sourceCount: number;
  stage: string;
  totalUpvotes?: number;
  totalComments?: number;
  exchange?: string | null;
  /** ATR(14) / price from daily bars; null when bars were unavailable. */
  atrPct?: number | null;
}

export function computeOpportunityScore(input: OpportunityScoreInput): number {
  let score = 0;

  // --- Signal age (0-20) --- ML: age > 3.5 days predicts best 1d returns; truly novel is unproven
  if (input.firstSeenDaysAgo === null) {
    score += 14; // truly novel — unproven for near-term execution
  } else if (input.firstSeenDaysAgo === 0) {
    score += 14; // first seen today — same as novel
  } else if (input.firstSeenDaysAgo <= 2) {
    score += 16; // 1-2 days: building validation
  } else if (input.firstSeenDaysAgo <= 5) {
    score += 20; // 3-5 days: sweet spot (ML: age > 3.5 predicts best 1d returns)
  } else {
    score += Math.max(0, 6 - input.priorAppearances);
  }

  // --- Inverted confidence (0-25): low aiScore = more upside ---
  score += Math.max(0, 25 - Math.floor(input.aiScore / 4));

  // --- Velocity (0-15) ---
  if (input.avgVelocity >= 2.5) score += 15;
  else if (input.avgVelocity >= 2.0) score += 12;
  else if (input.avgVelocity >= 1.5) score += 8;
  else if (input.avgVelocity >= 1.0) score += 4;

  // --- Volatility, ATR% (0-15) --- PR 1-0 replacement for the microcap and penny bonuses.
  // [Guessing] tiers; the universe floor is 3% ATR (or 40% HV).
  if (input.atrPct != null) {
    if (input.atrPct >= 0.06) score += 15;
    else if (input.atrPct >= 0.045) score += 10;
    else if (input.atrPct >= 0.03) score += 5;
  }

  // --- Near 52-week low (0-10) ---
  if (input.price != null && input.wk52Lo != null && input.wk52Lo > 0) {
    const pctFromLow = (input.price - input.wk52Lo) / input.wk52Lo;
    if (pctFromLow >= 0.007 && pctFromLow < 0.30) score += 10;
    else if (pctFromLow < 0.50) score += 5;
  }

  // --- Short squeeze potential (0-5) ---
  if (input.shortFloat != null) {
    if (input.shortFloat >= 0.15) score += 5;
    else if (input.shortFloat >= 0.075) score += 3;
  }

  // --- Freshness (0-5) ---
  if (input.medianSignalAgeHrs != null) {
    if (input.medianSignalAgeHrs < 3) score += 5;
    else if (input.medianSignalAgeHrs < 6) score += 3;
  }

  // --- Recovery ratio (0-4) --- ML: beaten-down stocks underperform momentum on average
  if (input.price != null && input.wk52Hi != null && input.price > 0) {
    const highRatio = input.wk52Hi / input.price;
    if (highRatio > 5.0) score += 4;
    else if (highRatio > 3.0) score += 3;
    else if (highRatio > 2.0) score += 2;
  }

  // --- Momentum / near 52W high (0-6) --- ML: low wk52_high_ratio (price near 52W high) predicts best 1d+7d returns
  if (input.price != null && input.wk52Hi != null && input.wk52Hi > 0) {
    const pctOfHigh = input.price / input.wk52Hi;
    if (pctOfHigh >= 0.95) score += 6;      // within 5% of 52W high — strong momentum
    else if (pctOfHigh >= 0.85) score += 3;  // within 15% — moderate momentum
  }

  // --- Moderate engagement boost (0-3) --- ML: reddit_comments > 33 predicts positive 3d returns
  const comments = input.totalComments ?? 0;
  if (comments >= 33 && comments <= 150) {
    score += 3;
  }

  // --- Comment-heavy penalty / conviction bonus (ML: upvote/comment ratio) ---
  const upvotes = input.totalUpvotes ?? 0;
  if (comments > 150 && upvotes / (comments || 1) < 2) {
    score -= 8; // peak hype
  } else if (upvotes > 200 && upvotes / (comments || 1) > 5) {
    score += 3; // conviction
  }

  // --- Price floor penalty (0 to -8) --- ML: price is #1 feature; sub-$0.20 underperforms across horizons
  if (input.price != null) {
    if (input.price < 0.12) score -= 8;
    else if (input.price < 0.20) score -= 4;
    else if (input.price < 0.52) score -= 2;
  }

  return Math.max(0, Math.min(100, score));
}
