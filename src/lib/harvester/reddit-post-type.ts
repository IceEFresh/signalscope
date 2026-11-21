/**
 * Reddit post type, PLAN.md PR 2c (Bradley, Hanousek, Jame & Xiao 2024: long-form
 * fundamental due-diligence posts on r/wallstreetbets carried information, while
 * hype and price-pressure posts did not). LOG ONLY: the type is stored per signal
 * and summarized in ValidatedTicker.features; no score, stage or label reads it.
 *
 * Rules (basis "rules_v1"), computed on the full post text before the source
 * trims the body to 2,000 characters:
 *   - comment: a comment-level signal (the paper studies submissions only).
 *   - dd:   long-form and fundamental. Either a DD-style flair with at least
 *           DD_FLAIR_MIN_WORDS words, or at least DD_MIN_WORDS words with at least
 *           DD_MIN_FUNDAMENTAL_TERMS distinct fundamental terms, and in both cases
 *           more fundamental terms than hype terms.
 *   - hype: a hype or gain/loss flair, or at least HYPE_MIN_TERMS hype terms
 *           (rockets, "to the moon", squeeze, YOLO, diamond hands, tendies...).
 *   - other: everything else (news links, questions, short opinions).
 */

export type RedditPostType = "dd" | "hype" | "other" | "comment";

export const REDDIT_POST_TYPE_BASIS = "rules_v1";
export const DD_FLAIR_MIN_WORDS = 300;
export const DD_MIN_WORDS = 600;
export const DD_MIN_FUNDAMENTAL_TERMS = 4;
export const HYPE_MIN_TERMS = 2;

const DD_FLAIRS = ["dd", "due diligence", "research", "fundamentals", "analysis"];
const HYPE_FLAIRS = ["yolo", "gain", "loss", "meme", "shitpost", "bet"];

/** Distinct fundamental-analysis terms; each counts once per post. */
const FUNDAMENTAL_TERMS: RegExp[] = [
  /\brevenue\b/i, /\bearnings\b/i, /\beps\b/i, /\bebitda\b/i, /\bmargins?\b/i,
  /\bfree cash flow\b|\bfcf\b/i, /\bcash flow\b/i, /\bbalance sheet\b/i, /\bdebt\b/i,
  /\bguidance\b/i, /\bvaluation\b/i, /\bp\/e\b|\bpe ratio\b|\bmultiple\b/i, /\bdcf\b/i,
  /\b10-?k\b|\b10-?q\b|\bsec filing\b/i, /\bbacklog\b/i, /\bmarket share\b/i,
  /\bgross profit\b/i, /\boperating income\b/i, /\bbook value\b/i, /\bdilution\b/i,
  /\bcompetitors?\b/i, /\bmanagement\b/i, /\bcapex\b/i, /\b(?:yoy|year over year)\b/i,
];

/** Hype and price-pressure terms; each occurrence counts. */
const HYPE_TERMS: RegExp[] = [
  /🚀/gu, /💎/gu, /🙌/gu, /🌙/gu, /\bto the moon\b/gi, /\bmoon(?:ing)?\b/gi, /\bsqueeze\b/gi,
  /\byolo\b/gi, /\btendies\b/gi, /\bdiamond hands?\b/gi, /\bapes?\b/gi, /\blfg\b/gi,
  /\bhodl\b/gi, /\bshort(?:s)? (?:are )?(?:fuk|fucked|r(?:e|ui)kt)\b/gi, /\bgamma\b/gi,
];

export interface RedditPostClass {
  postType: RedditPostType;
  words: number;
  fundamentalTerms: number;
  hypeTerms: number;
}

export function countWords(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/** Classify one post (title + full self-text). Pure. */
export function classifyRedditPost(
  { title, selftext, flair, isComment = false }: { title: string; selftext: string; flair?: string; isComment?: boolean },
): RedditPostClass {
  const text = `${title}\n${selftext}`;
  const words = countWords(selftext);
  const fundamentalTerms = FUNDAMENTAL_TERMS.filter((re) => re.test(text)).length;
  const hypeTerms = HYPE_TERMS.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
  const base = { words, fundamentalTerms, hypeTerms };
  if (isComment) return { postType: "comment", ...base };

  const f = flair?.toLowerCase() ?? "";
  const ddFlair = DD_FLAIRS.some((m) => f.includes(m));
  const hypeFlair = HYPE_FLAIRS.some((m) => f.includes(m));
  const fundamentalBeatsHype = fundamentalTerms > hypeTerms;

  if (fundamentalBeatsHype && ((ddFlair && words >= DD_FLAIR_MIN_WORDS) || (words >= DD_MIN_WORDS && fundamentalTerms >= DD_MIN_FUNDAMENTAL_TERMS))) {
    return { postType: "dd", ...base };
  }
  if (hypeFlair || hypeTerms >= HYPE_MIN_TERMS) return { postType: "hype", ...base };
  return { postType: "other", ...base };
}

/** Per-ticker summary keys for features (log only). Empty when the ticker has no Reddit signal. */
export function redditPostTypeFeatures(
  signals: ReadonlyArray<{ source: string; redditPostType?: RedditPostType; redditWords?: number; upvotes?: number }>,
): Record<string, number | string | null> {
  const red = signals.filter((s) => s.source === "REDDIT");
  if (red.length === 0) return {};
  const of = (t: RedditPostType) => red.filter((s) => s.redditPostType === t);
  const dd = of("dd");
  const typed = red.filter((s) => s.redditPostType).length;
  return {
    reddit_dd_count: dd.length,
    reddit_hype_count: of("hype").length,
    reddit_other_count: of("other").length,
    reddit_comment_count: of("comment").length,
    reddit_dd_max_upvotes: dd.length ? Math.max(...dd.map((s) => s.upvotes ?? 0)) : null,
    reddit_dd_max_words: dd.length ? Math.max(...dd.map((s) => s.redditWords ?? 0)) : null,
    reddit_post_type_basis: typed > 0 ? REDDIT_POST_TYPE_BASIS : null,
  };
}
