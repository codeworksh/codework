import "./utils/env.ts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { bashPlugin } from "../src/plugin/builtin/tool/bash.ts";
import { define, Section } from "../src/plugin/index.ts";
import { immediateOpen } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import * as Tool from "../src/tool/tool.ts";

/**
 * The Prompt domain stores one string and imposes no shape, so these assertions belong
 * to `codework.prompt.default`, not to the bucket. They exist because that body is what
 * every embedder gets when it passes no `plugins`, and nothing else pins it.
 */
describe("codework.prompt.default", () => {
	/** Runs one exchange and returns the system prompts the provider was handed. */
	const prompts = (
		root: string,
		harness: Omit<Parameters<typeof Harness.layer>[0], "home" | "database" | "llm"> = {},
		session: Omit<Parameters<typeof Session.create>[0], "directory"> = {},
	) => {
		const observed: string[] = [];
		const open = immediateOpen();
		return Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* Session.create({ directory: root, ...session });
				yield* handle.run("hello");
				return yield* handle.path();
			}).pipe(
				Effect.provide(
					Harness.layer({
						home: join(root, "home"),
						hostCwd: root,
						database: ":memory:",
						llm: (input, signal) => {
							observed.push(input.context.systemPrompt ?? "");
							return open(input, signal);
						},
						...harness,
					}),
				),
				Effect.scoped,
			),
		).then((path) => ({ observed, path }));
	};

	it("replaces the foundation with promptCustom and renders promptSystemAppend as the addendum", () =>
		withSettings(async ({ root }) => {
			const { observed } = await prompts(
				root,
				{ plugins: [defaultPromptPlugin] },
				{ systemPrompt: { custom: "Only this.", append: "  Extra section.  " } },
			);
			// No tool plugin ran, the foundation stays untagged, and the append is trimmed.
			expect(observed[0]).toBe(
				[
					"Only this.",
					"<tools>\n(none)\n</tools>",
					"<rules>\n- Be concise in your responses\n- Show file paths clearly when working with files\n</rules>",
					"<addendum>\nExtra section.\n</addendum>",
					`<cwd>\n${await realpath(root)}\n</cwd>`,
				].join("\n\n"),
			);
		}));

	it("fails the snapshot when a caller slot throws, before any request", () =>
		withSettings(async ({ root }) => {
			const { observed, path } = await prompts(
				root,
				{ plugins: [defaultPromptPlugin] },
				{
					systemPrompt: {
						custom: () => {
							throw new Error("slot exploded");
						},
					},
				},
			);
			expect(observed).toEqual([]);
			expect(path).toEqual([]);
		}));

	it("merges sections across plugins and renders custom ones after the built-ins", () =>
		withSettings(async ({ root }) => {
			const GithubPrRules = Section.define("github_pr_rules", { format: "list" });
			const Notes = Section.define("team-notes");
			const { observed } = await prompts(
				root,
				{
					plugins: [
						bashPlugin,
						defaultPromptPlugin,
						define({
							id: "acme.prompt.github",
							kind: "prompt",
							setup: (ctx) => {
								ctx.plugin.prompt.sections.append(Section.Rules, "Never push to main.");
								ctx.plugin.prompt.sections.append(GithubPrRules, "Link the issue in every PR description.");
								ctx.plugin.prompt.sections.append(Notes, "Reviewers: alice, bob.");
							},
						}),
						define({
							id: "acme.prompt.team",
							kind: "prompt",
							setup: (ctx) => {
								ctx.plugin.prompt.sections.append(Section.Rules, "Be concise  in your responses");
								ctx.plugin.prompt.sections.append(GithubPrRules, "Never force-push a branch under review.");
								ctx.plugin.prompt.sections.append(GithubPrRules, "Link the issue in every PR   description.");
								ctx.plugin.prompt.sections.append(Notes, "Release on Thursdays.");
							},
						}),
					],
				},
				{ systemPrompt: { append: "Always run tests with pnpm." } },
			);
			const prompt = (observed[0] ?? "").replaceAll(await realpath(root), "<root>");
			await expect(prompt).toMatchFileSnapshot("./__artifacts__/prompt.sections.txt");
		}));

	it("fails the snapshot when two plugins write one section in different formats", () =>
		withSettings(async ({ root }) => {
			const { observed, path } = await prompts(root, {
				plugins: [
					defaultPromptPlugin,
					define({
						id: "acme.prompt.list",
						kind: "prompt",
						setup: (ctx) => ctx.plugin.prompt.sections.append(Section.define("notes", { format: "list" }), "a"),
					}),
					define({
						id: "acme.prompt.text",
						kind: "prompt",
						setup: (ctx) => ctx.plugin.prompt.sections.append(Section.define("notes"), "b"),
					}),
				],
			});
			expect(observed).toEqual([]);
			expect(path).toEqual([]);
		}));

	it("tells the model to search with bash only while no dedicated search tool is registered", () =>
		withSettings(async ({ root }) => {
			const rule = "Use bash for file operations like ls, rg, find";
			const grep = define({
				id: "acme.tool.grep",
				kind: "tool",
				setup: (ctx) =>
					ctx.plugin.tools.add(
						Tool.register(
							Tool.make({
								name: "grep",
								description: "Search file contents.",
								parameters: Schema.Struct({}),
								success: Schema.String,
								handler: () => Effect.succeed(""),
							}),
						),
					),
			});
			const bashOnly = await prompts(root, { plugins: [bashPlugin, defaultPromptPlugin] });
			expect(bashOnly.observed[0]).toContain(`- ${rule}`);
			const withGrep = await prompts(root, { plugins: [bashPlugin, grep, defaultPromptPlugin] });
			expect(withGrep.observed[0]).not.toContain(rule);
			const noBash = await prompts(root, { plugins: [defaultPromptPlugin] });
			expect(noBash.observed[0]).not.toContain(rule);
		}));
});
