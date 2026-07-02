import { describe, expect, it } from "vitest";
import { deriveSampleQuery } from "./playwrightCrawler.js";
import type { AppFeature } from "../schema/appFeatureMap.js";

function feat(over: Partial<AppFeature> = {}): AppFeature {
  return {
    name: "Research",
    description: "AI-powered research assistant.",
    entryPath: "/research",
    importance: 4,
    suggestedFlow: [],
    ...over,
  };
}

describe("deriveSampleQuery", () => {
  it("never returns raw focus-keyword fragments ('save notion')", () => {
    // The function doesn't take keywords — it's tested indirectly by checking
    // it uses feature metadata, not the focus area string.
    const q = deriveSampleQuery(feat());
    expect(q).not.toMatch(/^save$/i);
    expect(q.length).toBeGreaterThan(5);
  });

  it("prefers the first suggestedFlow entry when it looks like a user input", () => {
    const q = deriveSampleQuery(feat({ suggestedFlow: ["Summarize the impact of renewable energy on global markets"] }));
    expect(q).toContain("Summarize");
  });

  it("ignores a suggestedFlow entry that starts with an action verb", () => {
    const q = deriveSampleQuery(feat({
      suggestedFlow: ["Click the Generate button", "See the results"],
      description: "Generates AI reports.",
    }));
    expect(q).not.toContain("Click");
    expect(q).toContain("Generates AI reports");
  });

  it("falls back to the feature description when suggestedFlow is empty", () => {
    const q = deriveSampleQuery(feat({ suggestedFlow: [], description: "Writes blog posts from bullet points." }));
    expect(q).toContain("blog posts");
  });

  it("falls back to generic when no useful metadata is available", () => {
    const q = deriveSampleQuery(feat({ suggestedFlow: [], description: "" }));
    expect(q).toBe("Give me a quick overview");
  });

  it("caps very long suggestedFlow entries to 200 chars", () => {
    const long = "A".repeat(300);
    const q = deriveSampleQuery(feat({ suggestedFlow: [long] }));
    expect(q.length).toBeLessThanOrEqual(200);
  });
});
