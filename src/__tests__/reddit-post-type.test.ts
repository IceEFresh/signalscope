import { describe, it, expect } from "vitest";
import {
  classifyRedditPost,
  countWords,
  redditPostTypeFeatures,
  REDDIT_POST_TYPE_BASIS,
  DD_FLAIR_MIN_WORDS,
  DD_MIN_WORDS,
} from "@/lib/harvester/reddit-post-type";

/** Filler prose of `n` words with no fundamental or hype terms. */
const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

// Shaped like a real long-form r/wallstreetbets DD post: thesis, financials, valuation, risks.
const ddBody = [
  "Thesis: the market is mispricing the turnaround.",
  "Revenue grew 18% year over year last quarter and gross profit expanded faster.",
  "Operating income turned positive and free cash flow covered capex for the first time.",
  "The balance sheet carries little debt after the refinancing described in the 10-K.",
  "Management raised guidance and the backlog is at a record.",
  "On valuation, a simple DCF puts fair value 40% above the current multiple; competitors trade at a higher P/E.",
  "Risks: dilution from the convertible and margin pressure if input costs rise.",
  filler(650),
].join("\n\n");

const hypeBody = "Shorts are fucked 🚀🚀🚀 this is going to the moon, diamond hands apes, YOLO'd my tendies into weeklies. LFG";

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("  a b\n\nc  ")).toBe(3);
    expect(countWords("")).toBe(0);
  });
});

describe("classifyRedditPost", () => {
  it("long-form fundamental post without a flair is dd", () => {
    const r = classifyRedditPost({ title: "XYZ: why the turnaround is real", selftext: ddBody });
    expect(r.postType).toBe("dd");
    expect(r.words).toBeGreaterThanOrEqual(DD_MIN_WORDS);
    expect(r.fundamentalTerms).toBeGreaterThanOrEqual(10);
  });

  it("DD flair needs fewer words but still needs to be long-form", () => {
    const shortDd = "Revenue, margins, guidance and debt all improved. " + filler(DD_FLAIR_MIN_WORDS);
    expect(classifyRedditPost({ title: "XYZ", selftext: shortDd, flair: "DD" }).postType).toBe("dd");
    expect(classifyRedditPost({ title: "XYZ", selftext: shortDd }).postType).toBe("other");
    expect(classifyRedditPost({ title: "XYZ to the moon", selftext: "Revenue up 🚀", flair: "DD" }).postType).toBe("hype");
  });

  it("rockets, squeeze talk and YOLO language are hype", () => {
    const r = classifyRedditPost({ title: "XYZ squeeze incoming 🚀", selftext: hypeBody });
    expect(r.postType).toBe("hype");
    expect(r.hypeTerms).toBeGreaterThanOrEqual(8);
  });

  it("a YOLO or gain/loss flair is hype even with little text", () => {
    expect(classifyRedditPost({ title: "XYZ", selftext: "", flair: "YOLO" }).postType).toBe("hype");
    expect(classifyRedditPost({ title: "XYZ", selftext: "", flair: "Gain" }).postType).toBe("hype");
    expect(classifyRedditPost({ title: "XYZ", selftext: "", flair: "Loss" }).postType).toBe("hype");
  });

  it("a long post stuffed with hype is not dd", () => {
    const r = classifyRedditPost({ title: "XYZ", selftext: ddBody + " " + "🚀 ".repeat(30) });
    expect(r.postType).toBe("hype");
  });

  it("news links and questions are other", () => {
    expect(classifyRedditPost({ title: "XYZ announces CFO change", selftext: "", flair: "News" }).postType).toBe("other");
    expect(classifyRedditPost({ title: "Thoughts on XYZ?", selftext: "Anyone holding?", flair: "Discussion" }).postType).toBe("other");
  });

  it("comments are their own type", () => {
    expect(classifyRedditPost({ title: "", selftext: ddBody, isComment: true }).postType).toBe("comment");
  });
});

describe("redditPostTypeFeatures", () => {
  it("is empty without Reddit signals", () => {
    expect(redditPostTypeFeatures([{ source: "SEC_INSIDER" }])).toEqual({});
  });

  it("counts each type and summarizes the DD posts", () => {
    expect(
      redditPostTypeFeatures([
        { source: "REDDIT", redditPostType: "dd", redditWords: 900, upvotes: 40 },
        { source: "REDDIT", redditPostType: "dd", redditWords: 1500, upvotes: 12 },
        { source: "REDDIT", redditPostType: "hype", redditWords: 20, upvotes: 300 },
        { source: "REDDIT", redditPostType: "comment", redditWords: 50 },
        { source: "REDDIT", redditPostType: "other" },
        { source: "STOCKTWITS" },
      ]),
    ).toEqual({
      reddit_dd_count: 2,
      reddit_hype_count: 1,
      reddit_other_count: 1,
      reddit_comment_count: 1,
      reddit_dd_max_upvotes: 40,
      reddit_dd_max_words: 1500,
      reddit_post_type_basis: REDDIT_POST_TYPE_BASIS,
    });
  });

  it("uses null, not 0, when there is no DD post or no typed signal", () => {
    expect(redditPostTypeFeatures([{ source: "REDDIT" }])).toMatchObject({
      reddit_dd_max_upvotes: null,
      reddit_dd_max_words: null,
      reddit_post_type_basis: null,
    });
  });
});
