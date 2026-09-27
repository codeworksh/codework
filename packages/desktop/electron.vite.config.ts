import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { fileURLToPath } from "node:url";

const aliases = [
	{ find: /^@codeworksh\/plugin$/, replacement: fileURLToPath(new URL("../plugin/src/index.ts", import.meta.url)) },
	{ find: /^@codeworksh\/plugin\/(.*)$/, replacement: fileURLToPath(new URL("../plugin/src/$1.ts", import.meta.url)) },
	{
		find: "@codeworksh/harness/effect",
		replacement: fileURLToPath(new URL("../harness/src/effect.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/harness/sandbox",
		replacement: fileURLToPath(new URL("../harness/src/sandbox.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/harness/sandboxes/daytona",
		replacement: fileURLToPath(new URL("../harness/src/sandboxes/daytona/index.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/harness/sandboxes/vercel",
		replacement: fileURLToPath(new URL("../harness/src/sandboxes/vercel/index.ts", import.meta.url)),
	},
	{ find: "@codeworksh/harness", replacement: fileURLToPath(new URL("../harness/src/index.ts", import.meta.url)) },
	{
		find: "@codeworksh/aikit/failure",
		replacement: fileURLToPath(new URL("../aikit/src/llm/failure.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/aikit/modelgen",
		replacement: fileURLToPath(new URL("../aikit/src/modelgen.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/aikit/oauth/openai/codex",
		replacement: fileURLToPath(new URL("../aikit/src/oauth/openai/codex.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/aikit/oauth/github/copilot",
		replacement: fileURLToPath(new URL("../aikit/src/oauth/github/copilot.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/aikit/oauth/interactive",
		replacement: fileURLToPath(new URL("../aikit/src/oauth/interactive.ts", import.meta.url)),
	},
	{
		find: "@codeworksh/aikit/oauth/summary",
		replacement: fileURLToPath(new URL("../aikit/src/oauth/summary.ts", import.meta.url)),
	},
	{ find: "@codeworksh/aikit", replacement: fileURLToPath(new URL("../aikit/src/index.ts", import.meta.url)) },
];

export default defineConfig({
	main: {
		plugins: [
			externalizeDepsPlugin({
				exclude: ["@codeworksh/harness", "@codeworksh/aikit", "@codeworksh/plugin"],
			}),
		],
		resolve: { alias: aliases },
		build: {
			lib: {
				entry: { index: fileURLToPath(new URL("./src/main.ts", import.meta.url)) },
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			lib: {
				entry: { index: fileURLToPath(new URL("./src/preload.ts", import.meta.url)) },
			},
		},
	},
	renderer: {
		root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
		server: {
			fs: {
				allow: [fileURLToPath(new URL(".", import.meta.url))],
			},
		},
		plugins: [react(), tailwindcss()],
	},
});
