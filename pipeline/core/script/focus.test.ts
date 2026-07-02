import { describe, expect, it } from "vitest";
import { extractFocusKeywords, textMatchesFocus, focusMatchScore } from "./focus.js";

describe("extractFocusKeywords", () => {
  it("returns nothing for empty/undefined input", () => {
    expect(extractFocusKeywords()).toEqual([]);
    expect(extractFocusKeywords("")).toEqual([]);
  });

  it("keeps content words and drops stopwords/punctuation", () => {
    const kw = extractFocusKeywords("I want the Save to Notion button to be clicked");
    expect(kw).toContain("save");
    expect(kw).toContain("notion");
    // stopwords / filler removed
    expect(kw).not.toContain("want");
    expect(kw).not.toContain("button");
    expect(kw).not.toContain("the");
  });

  it("suppresses words inside a negation window but keeps a later clause", () => {
    const kw = extractFocusKeywords("no need for theme, I want Save to Notion clicked");
    expect(kw).not.toContain("theme"); // negated
    expect(kw).toContain("notion"); // separate clause, kept
    expect(kw).toContain("save");
  });

  it("handles 'without X' negation", () => {
    const kw = extractFocusKeywords("export the result without dark mode");
    expect(kw).toContain("export");
    expect(kw).not.toContain("dark");
    expect(kw).not.toContain("mode");
  });
});

describe("textMatchesFocus / focusMatchScore", () => {
  const kw = ["save", "notion"];

  it("matches case-insensitively on substring", () => {
    expect(textMatchesFocus("Save to Notion", kw)).toBe(true);
    expect(textMatchesFocus("Export to PDF", kw)).toBe(false);
  });

  it("returns false when there are no keywords", () => {
    expect(textMatchesFocus("Save to Notion", [])).toBe(false);
  });

  it("scores by number of distinct keyword hits", () => {
    expect(focusMatchScore("Save to Notion", kw)).toBe(2);
    expect(focusMatchScore("Save draft", kw)).toBe(1);
    expect(focusMatchScore("Delete", kw)).toBe(0);
  });
});
