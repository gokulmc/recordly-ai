/**
 * StageEvent — emitted by the pipeline orchestrator via process.send()
 * and relayed by the Electron main process to the Auto-demo window renderer.
 */

export type StageId =
  | "ingest"
  | "crawl"
  | "script"
  | "record"
  | "derive"
  | "assemble"
  | "done"
  | "error";

export type StageStatus = "running" | "done" | "error";

export interface StageEvent {
  type: "stage";
  stageId: StageId;
  status: StageStatus;
  /** Human-readable message shown in the progress list */
  message: string;
  /** Optional structured payload — varies by stage */
  payload?: StagePayload;
}

export type StagePayload =
  | { kind: "ingest"; featureCount: number; fileCount: number; appName: string }
  | { kind: "crawl"; enrichedFeatures: number }
  | { kind: "script"; stepCount: number; preview: string[] }
  | { kind: "record"; eventCount: number; videoPath: string }
  | { kind: "derive"; zoomRegionCount: number }
  | { kind: "assemble"; projectPath: string }
  | { kind: "done"; projectPath: string }
  | { kind: "error"; error: string };
