import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppFeatureMap } from "../schema/appFeatureMap.js";
import type { CatalogEntry, Target } from "../schema/target.js";
import type { DemoStep } from "../record/types.js";

// Mock only the LLM call; keep parseJson as plain JSON.parse.
const chatMock = vi.fn<[unknown, unknown], Promise<string>>();
vi.mock("../../llm/deepseek.js", () => ({
  chat: (...args: [unknown, unknown]) => chatMock(...args),
  parseJson: (s: string) => JSON.parse(s),
  DEEPSEEK_SMART_MODEL: "mock-model",
}));

import { generateDemoScript } from "./demoScriptGen.js";

const PROD = "https://app.test";

function el(id: number, text: string, opts: Partial<CatalogEntry> = {}): CatalogEntry {
  const role = opts.role ?? "button";
  return {
    id,
    target: opts.target ?? { kind: "role", role, name: text },
    text,
    role,
    tag: opts.tag ?? "button",
    enabled: opts.enabled ?? true,
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    ...(opts.revealed ? { revealed: true } : {}),
  };
}

const REVEAL_STEPS: DemoStep[] = [
  { action: "fill", target: { kind: "role", role: "textbox", name: "Query" }, value: "hello", narration: "Typing a query." },
  { action: "click", target: { kind: "role", role: "button", name: "Generate" }, narration: "Generating." },
  { action: "wait", waitMs: 2000 },
];

function fixture(): AppFeatureMap {
  return {
    appName: "TestApp",
    appDescription: "A test app.",
    features: [
      { name: "Dashboard", description: "Main dashboard.", entryPath: "/dashboard", importance: 5, suggestedFlow: [], liveElements: [el(0, "Open settings"), el(1, "Refresh")] },
      {
        name: "Export",
        description: "Export your work.",
        entryPath: "/export",
        importance: 3,
        suggestedFlow: [],
        liveElements: [el(0, "Save to Notion", { revealed: true })],
        revealSteps: REVEAL_STEPS,
      },
    ],
    primaryFlows: [],
    authNeeded: false,
  };
}

const clickName = (s: DemoStep) => (s.action === "click" && s.target?.kind === "role" ? s.target.name : undefined);
const idxOfClick = (steps: DemoStep[], name: string) => steps.findIndex((s) => clickName(s) === name);
const idxOfNavigate = (steps: DemoStep[], pathEnd: string) => steps.findIndex((s) => s.action === "navigate" && (s.url ?? "").endsWith(pathEnd));

beforeEach(() => {
  chatMock.mockReset();
});

describe("generateDemoScript focus steering", () => {
  it("prepends a per-feature navigate before interacting", async () => {
    chatMock.mockResolvedValue(JSON.stringify([{ action: "click", feature: 1, element: 0, narration: "Open" }]));
    const script = await generateDemoScript(fixture(), PROD, {});
    expect(script.steps[0]?.action).toBe("navigate");
    expect(idxOfNavigate(script.steps, "/dashboard")).toBeGreaterThanOrEqual(0);
  });

  it("replays revealSteps before clicking a revealed (post-interaction) element", async () => {
    // focus pins Export; LLM clicks the revealed Save to Notion element (feature 1, el 0)
    chatMock.mockResolvedValue(JSON.stringify([{ action: "click", feature: 1, element: 0, narration: "Save it" }]));
    const script = await generateDemoScript(fixture(), PROD, { focusArea: "I want Save to Notion clicked" });

    const iGenerate = idxOfClick(script.steps, "Generate");
    const iSave = idxOfClick(script.steps, "Save to Notion");
    expect(iGenerate).toBeGreaterThanOrEqual(0); // reveal step replayed
    expect(iSave).toBeGreaterThan(iGenerate); // focus action after reveal
    expect(idxOfNavigate(script.steps, "/export")).toBeLessThan(iGenerate);
    expect(script.focusNotice).toBeUndefined();
  });

  it("injects the focus action when the model omits it", async () => {
    // LLM only touches Dashboard (feature 2, el 0) — never the focus element.
    chatMock.mockResolvedValue(JSON.stringify([{ action: "click", feature: 2, element: 0, narration: "Settings" }]));
    const script = await generateDemoScript(fixture(), PROD, { focusArea: "click Save to Notion" });

    const iSave = idxOfClick(script.steps, "Save to Notion");
    const iGenerate = idxOfClick(script.steps, "Generate");
    expect(iSave).toBeGreaterThanOrEqual(0); // injected
    expect(iGenerate).toBeGreaterThanOrEqual(0); // its reveal path injected too
    expect(iSave).toBeGreaterThan(iGenerate);
    expect(script.focusNotice).toBeUndefined();
  });

  it("injects a scroll into a feature segment that has none", async () => {
    chatMock.mockResolvedValue(JSON.stringify([{ action: "click", feature: 1, element: 0, narration: "Open" }]));
    const script = await generateDemoScript(fixture(), PROD, {});
    expect(script.steps.some((s) => s.action === "scroll")).toBe(true);
  });

  it("warns (focusNotice) when nothing in the captured UI matches", async () => {
    chatMock.mockResolvedValue(JSON.stringify([{ action: "click", feature: 1, element: 0, narration: "Open" }]));
    const script = await generateDemoScript(fixture(), PROD, { focusArea: "frobnicate the wizzbang" });
    expect(script.focusNotice).toBeTruthy();
    expect(script.steps.length).toBeGreaterThan(0); // still produces a demo
  });
});
