import "./utils/env.ts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { immediateOpen } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";

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

	it("indexes the default selection's tools, guidelines and working directory", () =>
		withSettings(async ({ root }) => {
			const { observed } = await prompts(root);
			const prompt = observed[0] ?? "";
			expect(prompt.startsWith("You are an expert coding assistant")).toBe(true);
			expect(prompt).toContain("Available tools:\n- bash: Execute bash commands");
			expect(prompt).toContain("\n\nGuidelines:\n- Be concise.");
			expect(prompt.endsWith(`Current working directory: ${root}`)).toBe(true);
		}));

	it("replaces the foundation with promptCustom and places promptSystemAppend before the directory line", () =>
		withSettings(async ({ root }) => {
			const { observed } = await prompts(
				root,
				{ plugins: ["codework.prompt.default"] },
				{ systemPrompt: { custom: "Only this.", append: "  Extra section.  " } },
			);
			// No tool plugin ran, the append is trimmed, and the directory line stays last.
			expect(observed[0]).toBe(
				[
					"Only this.",
					"Available tools:\n(none)",
					"Guidelines:\n- Be concise. Report what you did and what you found, not what you are about to do.\n- Quote exact paths and command output rather than paraphrasing them.\n- If a command fails, read the error before retrying.",
					"Extra section.",
					`Current working directory: ${root}`,
				].join("\n\n"),
			);
		}));

	it("fails the snapshot when a caller slot throws, before any request", () =>
		withSettings(async ({ root }) => {
			const { observed, path } = await prompts(
				root,
				{ plugins: ["codework.prompt.default"] },
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
});
