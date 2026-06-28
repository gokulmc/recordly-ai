/**
 * DeepSeek LLM client via its Anthropic-compatible endpoint.
 *
 * Key precedence (first wins):
 *   1. DEEPSEEK_API_KEY environment variable
 *   2. fork ai/apps/api/.env  (read at call time, not import time)
 *   3. ~/.recordly/app-settings.json → ai.deepseekApiKey
 *
 * Do NOT commit any key.
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEEPSEEK_FAST_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_SMART_MODEL = "deepseek-v4-pro";

let _client: Anthropic | null = null;

function readEnvFile(filePath: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const match = content.match(/^DEEPSEEK_API_KEY=(.+)$/m);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveKey(): string {
  // 1. env
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;

  // 2. pipeline/.env (sibling to this file's package root)
  const pipelineEnv = path.join(os.homedir(), "recordly-ai", "pipeline", ".env");
  const fromPipeline = readEnvFile(pipelineEnv);
  if (fromPipeline) return fromPipeline;

  // 4. forkai .env
  const fromForkai = readEnvFile(path.join(os.homedir(), "fork ai", "apps", "api", ".env"));
  if (fromForkai) return fromForkai;

  // 5. recordly app-settings
  const settingsPath = path.join(os.homedir(), ".recordly", "app-settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const key = (settings["ai"] as Record<string, string> | undefined)?.["deepseekApiKey"];
    if (key) return key;
  } catch {
    // not found
  }

  throw new Error(
    "No DEEPSEEK_API_KEY found. Set the env variable or add it to fork ai/apps/api/.env",
  );
}

function client(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: resolveKey(),
      baseURL: "https://api.deepseek.com/anthropic",
    });
  }
  return _client;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  /** If true, wrap system prompt to return JSON and parse response */
  json?: boolean;
}

export async function chat(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  opts: ChatOptions = {},
): Promise<string> {
  const params = {
    model: opts.model ?? DEEPSEEK_SMART_MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    messages,
    // Disable thinking for fast structured-JSON extraction (DeepSeek extension)
    thinking: { type: "disabled" as const },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = await client().messages.create(params as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = (message as any).content ?? [];
  return blocks
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text?: string }) => b.text ?? "")
    .join("");
}

/** Parse JSON from a model response, stripping markdown fences if present. */
export function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  return JSON.parse(cleaned) as T;
}
