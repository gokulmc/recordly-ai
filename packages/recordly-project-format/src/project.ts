/**
 * Project-file builders consumed by the pipeline child process.
 *
 * Compatible with recordly's own createProjectData / validateProjectData
 * (projectPersistence.ts) — the editor normalizes all defaults on load, so the
 * pipeline only needs to write the fields it actually controls.
 */

import type {
	CursorClickEffectStyle,
	CursorStyle,
	ZoomRegion,
} from "./types.js";

export const PROJECT_VERSION = 1;

/**
 * Subset of ProjectEditorState that the pipeline writes.
 * The app's normalizeProjectEditor fills in all other defaults on load.
 */
export interface PipelineEditorFields {
	zoomRegions?: ZoomRegion[];
	showCursor?: boolean;
	loopCursor?: boolean;
	cursorStyle?: CursorStyle;
	cursorClickEffect?: CursorClickEffectStyle;
	cursorClickEffectColor?: string;
	cursorClickEffectScale?: number;
	cursorClickEffectOpacity?: number;
	cursorClickEffectDurationMs?: number;
	cursorSize?: number;
	cursorSmoothing?: number;
	cursorSway?: number;
	cursorClickBounce?: number;
	cursorClickBounceDuration?: number;
	cursorMotionBlur?: number;
}

export interface EditorProjectData {
	version: number;
	projectId?: string;
	videoPath: string;
	editor: PipelineEditorFields;
}

export function createProjectData(
	videoPath: string,
	editor: PipelineEditorFields,
	projectId?: string | null,
): EditorProjectData {
	return {
		version: PROJECT_VERSION,
		...(typeof projectId === "string" && projectId.trim().length > 0
			? { projectId }
			: {}),
		videoPath,
		editor,
	};
}

export function validateProjectData(candidate: unknown): candidate is EditorProjectData {
	if (!candidate || typeof candidate !== "object") return false;
	const project = candidate as Partial<EditorProjectData>;
	if (typeof project.version !== "number") return false;
	if (project.projectId !== undefined && typeof project.projectId !== "string") return false;
	if (typeof project.videoPath !== "string" || !project.videoPath) return false;
	if (!project.editor || typeof project.editor !== "object") return false;
	return true;
}
