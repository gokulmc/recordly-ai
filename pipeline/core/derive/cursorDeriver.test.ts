import { describe, expect, it } from "vitest";
import { deriveCursorTelemetry } from "./cursorDeriver.js";
import { sampleTrace } from "./__fixtures__/sampleTrace.js";

describe("deriveCursorTelemetry", () => {
	const { samples, file } = deriveCursorTelemetry(sampleTrace);

	it("emits a dense, time-sorted stream in the sidecar v2 shape", () => {
		expect(file.version).toBe(2);
		expect(samples.length).toBeGreaterThan(200); // ~30Hz over 11s
		const times = samples.map((s) => s.timeMs);
		expect(times).toEqual([...times].sort((a, b) => a - b));
		expect(samples.every((s) => s.timeMs >= 0 && s.timeMs <= sampleTrace.totalMs)).toBe(true);
		expect(samples.every((s) => s.cx >= 0 && s.cx <= 1 && s.cy >= 0 && s.cy <= 1)).toBe(true);
	});

	it("never teleports the cursor between samples", () => {
		let maxJump = 0;
		for (let i = 1; i < samples.length; i++) {
			const a = samples[i - 1]!;
			const b = samples[i]!;
			maxJump = Math.max(maxJump, Math.hypot(b.cx - a.cx, b.cy - a.cy));
		}
		expect(maxJump).toBeLessThan(0.1);
	});

	it("tags the click interactions at the action timestamps", () => {
		const clicks = samples.filter((s) => s.interactionType === "click");
		const clickTimes = clicks.map((s) => s.timeMs);
		expect(clickTimes).toContain(1000);
		expect(clickTimes).toContain(1500);
		expect(clickTimes).toContain(6000);
	});

	it("adopts the I-beam over the text field", () => {
		const atFill = samples.find((s) => s.timeMs === 9000);
		expect(atFill?.cursorType).toBe("text");
	});

	it("adopts the pointer as it arrives at a button", () => {
		const justBeforeIcon = samples
			.filter((s) => s.timeMs < 6000 && s.timeMs >= 6000 - 160)
			.pop();
		expect(justBeforeIcon?.cursorType).toBe("pointer");
	});
});
