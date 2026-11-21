export type Source = "REDDIT" | "STOCKTWITS" | "SEC_INSIDER" | "SEC_FILING" | "OPTIONS_FLOW" | "VOLUME_SPIKE" | "TWITTER" | "CONGRESS" | "POLYMARKET" | "GRADUATION";

export interface RawSignal {
  symbol: string;
  source: Source;
  title?: string;
  body?: string;
  url?: string;
  author?: string;
  authorAge?: number;
  authorKarma?: number;
  upvotes?: number;
  commentCount?: number;
  subreddit?: string;
  postAge?: number;         // hours since post creation
  sortType?: string;        // "new" | "rising" | "hot" — needed for velocity weighting
  flair?: string;            // Reddit post flair (DD, News, Meme, etc.) — used for velocity weighting
  watchlistCount?: number;  // StockTwits watchlist count
  insiderTitle?: string;    // insider's role (CEO, CFO, Director, etc.)
  purchaseValue?: number;   // dollar value of insider purchase
  optionType?: string;      // "Call" | "Put"
  optionVolume?: number;    // total option volume
  openInterest?: number;    // open interest
  volOiRatio?: number;      // volume / open interest ratio
  netPremium?: number;       // call_premium - put_premium in $ (positive = bullish)
  callPremiumRatio?: number; // call_premium / (call + put premium), 0-1
  volumeRatio?: number;     // current volume / 10-day avg volume
  // X/Twitter-specific fields
  retweetCount?: number;
  likeCount?: number;
  replyCount?: number;
  quoteCount?: number;
  followerCount?: number;
  isVerified?: boolean;
  tweetType?: string;       // "cashtag" | "keyword"
  // Polymarket-specific fields
  marketProbability?: number;  // implied probability (0–1)
  marketVolume24hr?: number;   // 24h volume in USD
  marketLiquidity?: number;    // available liquidity in USD
  marketEndDate?: string;      // market expiration (ISO)
  // Graduation watch (PLAN.md PR 1-0)
  filedAt?: string;            // filing or disclosure date of an insider/congress trade (ISO or YYYY-MM-DD)
  tradeDate?: string;          // SEC_INSIDER: transaction date (YYYY-MM-DD)
  insiderClass?: "routine" | "opportunistic" | "unclassified"; // SEC_INSIDER: PLAN.md 2a, log only
  insiderPriorYears?: number;  // SEC_INSIDER: prior calendar years (of 3) with a Form 4 at this issuer
  filingKey?: string;          // stable id of the underlying filing, used to de-duplicate watch rows
  reportingGapDays?: number;   // congress: days between trade and disclosure
  graduationSource?: string;   // GRADUATION: INSIDER | POLITICIAN | ACTIVIST | NEW_INSIDER
  filingAgeDays?: number;      // GRADUATION: days since the watched filing
  flippedCriteria?: string[];  // GRADUATION: universe criteria that failed last check and pass now
}

export interface ScoredSignal extends RawSignal {
  velocityScore: number;
  sentiment?: string;
}

export interface PndResult {
  flagged: boolean;
  flags: string[];
  score: number;
}

export interface FundamentalData {
  price: number | null;
  marketCap: number | null;
  shortFloat: number | null;
  fiftyTwoWeekRange?: string;
  wk52Lo?: number | null;
  wk52Hi?: number | null;
  name?: string;
  sector?: string;
  /** PR 1f: Yahoo assetProfile.industry */
  industry?: string;
  exchange?: string;
  earningsDate?: string;
  /** PR 1b: earnings release (unix s), Yahoo's estimated window, and whether it is an estimate */
  earningsTs?: number | null;
  earningsTsStart?: number | null;
  earningsTsEnd?: number | null;
  isEarningsDateEstimate?: boolean | null;
  floatShares?: number | null;
  sharesOutstanding?: number | null;
}

export type SignalType = "insider_buy" | "options_flow" | "congress_buy" | "multi_source" | "reddit_velocity" | "twitter_velocity" | "polymarket_activity" | "graduation";

export interface AiScoreResult {
  symbol: string;
  score: number;
  rawScore: number;
  sentiment: string;
  reasoning: string;
}

export interface PndAiResult {
  flagged: boolean;
  confidence?: number;
  reasoning?: string;
}

/** LLM-owned fields only — bracket math is filled by applyAnchoredBracket(). */
export interface TradeSetupDraft {
  entryLo: number;
  entryHi: number;
  confidence: "Low" | "Medium" | "High";
}

export interface TradeSetup extends TradeSetupDraft {
  stopLoss: number;
  target1: number;
  target2: number;
  timeframe: string;
  riskReward: string;
}

export interface TickerReport {
  catalyst: string;
  risks: string;
  recommendation: string;
  report: string;
  tradeSetup?: TradeSetup;
}

/** LLM output before finalizeReport — bracket fields not yet computed. */
export interface UnfinalizedTickerReport extends Omit<TickerReport, "tradeSetup"> {
  tradeSetup?: TradeSetupDraft;
}

export interface NoveltyContext {
  firstSeenAt: Date | null;
  daysSinceFirstSeen: number | null;
  priorAppearances: number;
  isNovel: boolean;
}

export interface MomentumBreakdown {
  risingCount: number;
  freshCount: number;       // postAge < 3h
  recentCount: number;      // postAge 3-12h
  commentDerivedCount: number;
  staleCount: number;       // postAge > 12h
}

/** Per-symbol liquidity/volatility metrics computed on the harvester (null = unavailable). */
export interface IngestBarMetrics {
  dollarVolume20d: number | null;
  atrPct: number | null;
  hv20: number | null;
}

/** Result of re-checking one graduation-watch row against the universe rule. */
export interface WatchCheck {
  watchId: string;
  failingCriteria: string[];
  graduated: boolean;
  flippedCriteria: string[];
}

export interface HarvestIngestPayload {
  signals: RawSignal[];
  harvestedAt: string; // ISO timestamp
  /** Universe the harvester scanned with; null/absent = static SCAN_SYMBOLS fallback. */
  universeId?: string | null;
  barMetrics?: Record<string, IngestBarMetrics>;
  /** PLAN.md 1a bar features per symbol (log only), stored in ValidatedTicker.features. */
  barFeatures?: Record<string, Record<string, number | boolean | string | null>>;
  /** PLAN.md 1g STP states and triggers per scanned symbol (log only), stored in StpSignal. */
  stp?: Record<string, IngestStp>;
  /** PLAN.md 1c market regime fields for this scan (log only), stored on Scan.regimeFeatures. */
  regime?: Record<string, number | boolean | string | null>;
  /** PLAN.md 1f sector and industry rotation for this scan (log only), stored on Scan.sectorRotation. */
  sectorRotation?: unknown;
  /** PLAN.md 1h option-chain features per symbol (log only), merged into ValidatedTicker.features. */
  optionsFeatures?: Record<string, Record<string, number | null>>;
  watchChecks?: WatchCheck[];
}

export interface IngestStp {
  barDate: string | null;
  htfOpens: number | null;
  maState: number | null;
  wellBid: number | null;
  sizeFactor: number | null;
  trigger: number | null;
  triggerType: string | null;
  firedRules: string[];
  atr14: number | null;
  fudge: number | null;
  entry: number | null;
  stop: number | null;
  risk: number | null;
  target2R: number | null;
  target3R: number | null;
  addLevel2R: number | null;
  addLevel3R: number | null;
}

export interface AggregatedSymbol {
  symbol: string;
  signals: RawSignal[];
  sourceCount: number;
  weightedSourceScore: number;
  subredditCount: number;
  totalUpvotes: number;
  totalComments: number;
  avgVelocity: number;
  momentum: MomentumBreakdown;
  medianSignalAgeHrs: number | null; // median postAge across social signals (hours)
  netPremium?: number;
  callPremiumRatio?: number;
}
