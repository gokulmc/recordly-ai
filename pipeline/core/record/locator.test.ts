import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../schema/target.js";
import { catalogKey } from "./locator.js";

function entry(over: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: 0,
    target: { kind: "role", role: "button", name: "Save" },
    text: "Save",
    role: "button",
    tag: "button",
    enabled: true,
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    ...over,
  };
}

describe("catalogKey", () => {
  it("distinguishes controls that share a role/name but have different targets", () => {
    const a = entry({ target: { kind: "testId", value: "save-notion" } });
    const b = entry({ target: { kind: "testId", value: "save-draft" } });
    // Same role + visible text "Save" — the old role:name key collided; the full
    // descriptor must keep them apart so neither is silently dropped.
    expect(catalogKey(a)).not.toBe(catalogKey(b));
  });

  it("is stable for identical entries", () => {
    expect(catalogKey(entry({}))).toBe(catalogKey(entry({})));
  });

  it("separates same-target controls with different tags", () => {
    const link = entry({ target: { kind: "text", value: "More" }, role: "link", tag: "a", text: "More" });
    const button = entry({ target: { kind: "text", value: "More" }, role: "button", tag: "button", text: "More" });
    expect(catalogKey(link)).not.toBe(catalogKey(button));
  });
});
