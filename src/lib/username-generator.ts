import { randomInt } from "node:crypto";
const ADJECTIVES = [
  "swift", "keen", "bold", "sharp", "bright",
  "quick", "steady", "eagle", "iron", "silver",
  "golden", "alert", "sonic", "prime", "cyber",
];

const NOUNS = [
  "falcon", "hawk", "wolf", "bear", "bull",
  "trader", "scout", "signal", "apex", "ranger",
  "viper", "lynx", "titan", "pulse", "radar",
];

export function generateUsername(): string {
  const adj = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  const num = randomInt(100, 1000); // 100–999
  return `${adj}_${noun}_${num}`;
}
