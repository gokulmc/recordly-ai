import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: __dirname,
	// Pure Node package — stop Vite from climbing to the parent repo's
	// postcss.config.cjs / tailwind setup.
	css: { postcss: { plugins: [] } },
	resolve: {
		alias: {
			"recordly-project-format": path.resolve(
				__dirname,
				"../packages/recordly-project-format/src/index.ts",
			),
		},
	},
	test: {
		include: ["core/**/*.test.ts"],
		environment: "node",
	},
});
