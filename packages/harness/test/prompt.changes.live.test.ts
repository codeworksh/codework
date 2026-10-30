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
 * A prompt section changed between two prompts reaches a real model. Codex takes system messages
 * in place, so the second request still carries the first codeword and adds the change after it,
 * ahead of the prompt it came with.
 */

const Codeword = Section.define("codeword");
const live = { provider: "openai-codex", id: "gpt-6-luna" } as const;

describe("prompt sections against live openai-codex", () => {
	it.skipIf(!process.env.OPENAI_CODEX_API_KEY?.trim())(
		"answers from a section changed between prompts, sent in place",
		{ timeout: 300_000 },
		() =>
			withSettings(async ({ root, custom }) => {
				await writeFile(join(custom, "settings.jsonc"), JSON.stringify({ model: live }));
				const state = { word: "alpha" };
				const codeword = define({
					id: "acme.prompt.codeword",
					kind: "prompt",
					setup: (ctx) =>
						ctx.plugin.prompt.sections.append(
							Codeword,
							`The codeword is ${state.word}. Asked for the codeword, reply with it and nothing else.`,
						),
				});
				const bodies: string[] = [];
				const onPayload: NonNullable<State.RequestOptions["onPayload"]> = async (payload) => {
					bodies.push(JSON.stringify(payload));
					return payload;
				};

				const replies = await Effect.gen(function* () {
					const handle = yield* Session.create({ directory: root });
					const runtime = yield* SessionRuntime.Service;
					yield* runtime.update(handle.id, { onPayload });
					yield* handle.main.run("What is the codeword?");
					state.word = "bravo";
					yield* handle.main.run("What is the codeword now?");
					const messages = yield* Effect.forEach(yield* handle.main.history(), ContextCodec.decodeMessage);
					return messages.flatMap((message) =>
						message.role === "assistant"
							? [
									message.parts
										.flatMap((part) => (part.type === "text" ? [part.text] : []))
										.join("")
										.trim()
										.toLowerCase(),
								]
							: [],
					);
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
				const artifact = {
					answers: replies.map((reply) => ["alpha", "bravo"].find((word) => reply.includes(word))),
					promptChange: second.includes('Updated system prompt section \\"codeword\\"') ? "in place" : "folded",
					earlierSectionSent: second.includes("The codeword is alpha."),
					changeBeforePrompt:
						second.indexOf("The codeword is bravo.") >= 0 &&
						second.indexOf("The codeword is bravo.") < second.indexOf("What is the codeword now?"),
				};
				expect(artifact.promptChange).toBe("in place");
				expect(artifact.changeBeforePrompt).toBe(true);
				await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
					"./__artifacts__/prompt.changes.live.openai-codex.json",
				);
			}),
	);
});
