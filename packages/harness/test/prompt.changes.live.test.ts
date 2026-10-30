import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { define, Section } from "../src/plugin/index.ts";
import { SessionRuntime } from "../src/session/runtime.ts";
import type { State } from "../src/state/state.ts";
import { withSettings } from "./fixtures/settings.ts";
import "./utils/live.ts";

/**
 * A prompt section changed between two prompts reaches a real model. These models take system
 * messages in place, so the second request still carries the first codeword and adds the change
 * after it: ahead of the prompt it came with, or on Anthropic, which takes one only after a user
 * message, right after that prompt. Where caching is explicit (Anthropic), the second request
 * reads the first one's sections from the cache; OpenAI's is best effort, so it is not checked there.
 */

const Codeword = Section.define("codeword");
const Reference = Section.define("reference");
/** A fixed section past every provider's minimum cacheable prefix. */
const reference = Array.from({ length: 300 }, (_, i) => `Reference line ${i}: the archive holds item ${i * 7}.`).join(
	"\n",
);
process.env.CODEWORK_CACHE_RETENTION ??= "short";
const CASES = [
	{ name: "openai-codex", provider: "openai-codex", id: "gpt-6-luna", env: "OPENAI_CODEX_API_KEY", change: "before" },
	{ name: "openai", provider: "openai", id: "gpt-6-luna", env: "OPENAI_API_KEY", change: "before" },
	{
		name: "anthropic",
		provider: "anthropic",
		id: "claude-sonnet-5-5",
		env: "ANTHROPIC_API_KEY",
		change: "after",
		cache: true,
	},
	{
		name: "github-copilot",
		provider: "github-copilot",
		id: "claude-sonnet-5.5",
		env: "COPILOT_GITHUB_TOKEN",
		change: "after",
		cache: true,
	},
] as const;

describe.each(CASES)("prompt sections against live $name", (c) => {
	const { name, provider, id, env, change } = c;
	const cache = "cache" in c && c.cache;
	it.skipIf(!process.env[env]?.trim())(
		"answers from a section changed between prompts, sent in place",
		{ timeout: 300_000 },
		() =>
			withSettings(async ({ root, custom }) => {
				await writeFile(join(custom, "settings.jsonc"), JSON.stringify({ model: { provider, id } }));
				const state = { word: "alpha" };
				const codeword = define({
					id: "acme.prompt.codeword",
					kind: "prompt",
					setup: (ctx) => {
						ctx.plugin.prompt.sections.append(Reference, reference);
						ctx.plugin.prompt.sections.append(
							Codeword,
							`The codeword is ${state.word}. Asked for the codeword, reply with it and nothing else.`,
						);
					},
				});
				const bodies: string[] = [];
				const onPayload: NonNullable<State.RequestOptions["onPayload"]> = async (payload) => {
					bodies.push(JSON.stringify(payload));
					return payload;
				};

				const { replies, cacheRead } = await Effect.gen(function* () {
					const handle = yield* Session.create({ directory: root });
					const runtime = yield* SessionRuntime.Service;
					yield* runtime.update(handle.id, { onPayload });
					yield* handle.main.run("What is the codeword?");
					state.word = "bravo";
					yield* handle.main.run("What is the codeword now?");
					const messages = yield* Effect.forEach(yield* handle.main.history(), ContextCodec.decodeMessage);
					const assistants = messages.flatMap((message) => (message.role === "assistant" ? [message] : []));
					return {
						replies: assistants.map((message) =>
							message.parts
								.flatMap((part) => (part.type === "text" ? [part.text] : []))
								.join("")
								.trim()
								.toLowerCase(),
						),
						cacheRead: assistants.at(-1)?.usage.cacheRead ?? 0,
					};
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							hostCwd: root,
							database: ":memory:",
							userConfigDir: custom,
							plugins: [codeword],
						}),
					),
					Effect.scoped,
					Effect.timeout("240 seconds"),
					Effect.runPromise,
				);

				expect(bodies).toHaveLength(2);
				expect(replies).toHaveLength(2);
				expect(replies[0]).toContain("alpha");
				expect(replies[1]).toContain("bravo");
				const second = bodies[1]!;
				const bravo = second.indexOf("The codeword is bravo.");
				const artifact = {
					answers: replies.map((reply) => ["alpha", "bravo"].find((word) => reply.includes(word))),
					promptChange: second.includes('Updated system prompt section \\"codeword\\"') ? "in place" : "folded",
					earlierSectionSent: second.includes("The codeword is alpha."),
					change: bravo < 0 ? "missing" : bravo < second.indexOf("What is the codeword now?") ? "before" : "after",
					// The change kept the prefix: the second request reads the first one's sections from the cache.
					...(cache ? { cached: cacheRead > 0 } : {}),
				};
				expect(artifact.promptChange).toBe("in place");
				expect(artifact.change).toBe(change);
				if (cache) expect(artifact.cached).toBe(true);
				await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
					`./__artifacts__/prompt.changes.live.${name}.json`,
				);
			}),
	);
});
