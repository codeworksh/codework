import "./utils/env.ts";
import type { Message } from "@codeworksh/aikit";
import { Effect } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import type { PluginRef } from "../src/plugin/catalog.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { bashPlugin } from "../src/plugin/builtin/tool/bash.ts";
import { immediateOpen, toolTurn } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import { pendingCall } from "./tools.fixture.ts";

/**
 * The shipped examples under `extras/`, exercised as a third party would use them: two packages
 * and two single-file scripts, loaded by path, each configured through its entry's `options`.
 * They are documentation, so they are loaded here rather than described — a broken example, or a
 * manifest that does not resolve, is a failing test. The packages are loaded as package
 * directories, through their own `package.json`, exactly as a settings entry naming a path would.
 */
const example = (name: string) => fileURLToPath(new URL(`../../../extras/${name}`, import.meta.url));

const run = (root: string, plugins: ReadonlyArray<PluginRef>, llm = immediateOpen()) => {
	const contexts: Message.Context[] = [];
	return Effect.gen(function* () {
		const session = yield* Session.create({ directory: root });
		yield* session.run("hello");
		return { contexts, path: yield* session.path() } as const;
	}).pipe(
		Effect.provide(
			Harness.layer({
				home: join(root, "home"),
				database: ":memory:",
				llm: (request, signal) => {
					contexts.push(request.context);
					return llm(request, signal);
				},
				plugins,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);
};

const selection: ReadonlyArray<PluginRef> = [
	bashPlugin,
	example("codework-tool-proc"),
	example("plugins/local.ts"),
	{ package: example("plugins/local.ts"), options: { facts: { deploy: "vercel" } } },
	defaultPromptPlugin,
	example("codework-prompt-life"),
	// The README's second line: configure by the package name, not the path it was loaded from.
	{ package: "@acme/codework-prompt-life", options: { answer: 43 } },
	example("plugins/house-style.ts"),
	{ package: example("plugins/house-style.ts"), options: { rules: ["No `any` in TypeScript."] } },
];

describe("extras examples", () => {
	it("registers every example tool and composes the prompt in selection order", () =>
		withSettings(async ({ root }) => {
			const { contexts } = await run(root, selection);
			const context = contexts[0];
			expect(context?.tools?.map((tool) => tool.name)).toEqual(["bash", "list_processes", "project_fact"]);
			const prompt = context?.systemPrompt ?? "";
			// The prompt plugin was named after the tool plugins, so its index carries them.
			expect(prompt).toContain("- list_processes: List the processes running in the session's environment.");
			expect(prompt).toContain("- project_fact: Look up a project convention: deploy.");
			// Each example read its own options block.
			expect(prompt).toContain("- The short version: 43.");
			expect(prompt).toContain("## House style");
			expect(prompt).toContain("- No `any` in TypeScript.");
			// Composition order: the built-in body, then life, then house style last.
			expect(prompt.indexOf("## On the meaning of life")).toBeLessThan(prompt.indexOf("## House style"));
		}));

	it("runs a single-file example tool through the loop", () =>
		withSettings(async ({ root }) => {
			const { path } = await run(
				root,
				selection,
				toolTurn(pendingCall("project_fact", { key: "deploy" }, "call_fact")),
			);
			expect(JSON.parse(path[1]?.parts[0]?.data ?? "{}")).toMatchObject({
				status: "completed",
				result: { content: [{ type: "text", text: "vercel" }] },
			});
		}));

	it("configures a package example by the name its manifest declares", () =>
		withSettings(async ({ root }) => {
			const { contexts } = await run(root, [
				example("codework-tool-proc"),
				{ package: "@acme/codework-tool-proc", options: { limit: 1 } },
				defaultPromptPlugin,
			]);
			// The path loaded it; the package name addressed it; the ID would have worked too.
			expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["list_processes"]);
			expect(contexts[0]?.tools?.[0]?.description).toContain("Returns at most 1 rows");
		}));

	it("contributes nothing when an example is configured with an empty block", () =>
		withSettings(async ({ root }) => {
			// Both single-file examples are inert without configuration rather than registering an
			// empty tool or an empty prompt section.
			const { contexts } = await run(root, [
				bashPlugin,
				example("plugins/local.ts"),
				defaultPromptPlugin,
				example("plugins/house-style.ts"),
			]);
			expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["bash"]);
			expect(contexts[0]?.systemPrompt ?? "").not.toContain("## House style");
		}));
});
