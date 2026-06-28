/**
 * StageEvent — emitted by the pipeline orchestrator via process.send()
 * and relayed by the Electron main process to the Auto-demo window renderer.
 */

import type { AppFeatureMap } from "./appFeatureMap.js";
import type { RecordingScript } from "../record/types.js";

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
  | {
      kind: "script";
      stepCount: number;
      preview: string[];
      /** Full feature map — used by renderer to render the flowchart */
      featureMap: AppFeatureMap;
      /** Full recording script — used by renderer to display step detail */
      script: RecordingScript;
    }
  | { kind: "record"; eventCount: number; videoPath: string; traceJsonPath: string }
  | { kind: "derive"; zoomRegionCount: number }
  | { kind: "assemble"; projectPath: string }
  | { kind: "done"; projectPath: string }
  | { kind: "error"; error: string };
