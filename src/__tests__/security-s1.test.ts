import { describe, it, expect } from "vitest";
import { decodeHtmlEntities } from "@/lib/harvester/sources/stocktwits";
import { generateUsername } from "@/lib/username-generator";

describe("decodeHtmlEntities (CodeQL js/double-escaping)", () => {
  it("decodes in one pass, so an escaped entity stays escaped", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeHtmlEntities("&amp;quot;")).toBe("&quot;");
  });
  it("decodes the five basic entities", () => {
    expect(decodeHtmlEntities("{&quot;symbol&quot;:&quot;A&amp;B&quot;,&#39;x&#39;:&lt;1&gt;}")).toBe(`{"symbol":"A&B",'x':<1>}`);
  });
});

describe("generateUsername (CodeQL js/insecure-randomness)", () => {
  it("keeps the adjective-noun-number shape", () => {
    for (let i = 0; i < 50; i++) {
      const u = generateUsername();
      const n = Number(u.match(/(\d+)$/)?.[1]);
      expect(n).toBeGreaterThanOrEqual(100);
      expect(n).toBeLessThanOrEqual(999);
    }
  });
});
