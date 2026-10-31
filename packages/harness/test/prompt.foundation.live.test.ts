import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { SessionRuntime } from "../src/session/runtime.ts";
import type { State } from "../src/state/state.ts";
import { withSettings } from "./fixtures/settings.ts";
import "./utils/live.ts";

/**
 * One session on a buggy function, three threads: main explains it with the default foundation,
 * a reviewer fork and a tester fork each lead with their own. Each reply opens with its thread's
 * marker, every request carries its own thread's foundation, and the thread info reports it.
 */

const REVIEWER =
	"You are a strict code reviewer. Begin every reply with the line `REVIEW:`, then list the concrete defects you find.";
const TESTER =
	"You write unit tests. Begin every reply with the line `TESTS:`, then give the test code and nothing else.";
const CODE = "function average(xs) { return xs.reduce((a, b) => a + b) / xs.length; }";

const CASES = [
	{ name: "anthropic", provider: "anthropic", id: "claude-sonnet-5-5", env: "ANTHROPIC_API_KEY" },
	{ name: "openai", provider: "openai", id: "gpt-6-luna", env: "OPENAI_API_KEY" },
	{ name: "openai-codex", provider: "openai-codex", id: "gpt-6-luna", env: "OPENAI_CODEX_API_KEY" },
	{
		name: "copilot-claude-sonnet-5.5",
		provider: "github-copilot",
		id: "claude-sonnet-5.5",
		env: "COPILOT_GITHUB_TOKEN",
	},
] as const;

describe.each(CASES)("thread foundations against live $name", ({ name, provider, id, env }) => {
	it.skipIf(!process.env[env]?.trim())("leads each forked thread with its own foundation", { timeout: 300_000 }, () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(custom, "settings.jsonc"), JSON.stringify({ model: { provider, id } }));
			const bodies: string[] = [];
			const onPayload: NonNullable<State.RequestOptions["onPayload"]> = async (payload) => {
				bodies.push(JSON.stringify(payload));
				return payload;
			};
			/** The text of a thread's last reply. */
			const lastReply = (thread: Session.ThreadHandle) =>
				Effect.gen(function* () {
					const messages = yield* Effect.forEach(yield* thread.history(), ContextCodec.decodeMessage);
					const reply = messages.findLast((message) => message.role === "assistant")!;
					return ContextCodec.parts(reply)
						.flatMap((part) => (part.type === "text" ? [part.text] : []))
						.join("")
						.trim();
				});

			const result = await Effect.gen(function* () {
				const handle = yield* Session.create({ directory: root });
				const runtime = yield* SessionRuntime.Service;
				yield* runtime.update(handle.id, { onPayload });
				const main = handle.main;
				yield* main.run(`Here is my function:\n\n${CODE}\n\nIn one sentence, what does it do?`);
				const explained = (yield* main.history()).findLast(({ entry }) => entry.type === "assistant")!;
				const explanation = yield* lastReply(main);

				const { thread: reviewer } = yield* main.fork({ entryId: explained.entry.id });
				yield* reviewer.configure({ foundation: REVIEWER });
				yield* reviewer.run("Review the function.");
				const review = yield* lastReply(reviewer);

				const { thread: tester } = yield* main.fork({ entryId: explained.entry.id });
				yield* tester.configure({ foundation: TESTER });
				yield* tester.run("Write one test for the input that breaks it.");
				const tests = yield* lastReply(tester);

				yield* main.run("Thanks. Is there anything to watch out for when calling it?");
				const followUp = yield* lastReply(main);

				const info = {
					main: (yield* main.info).foundation,
					reviewer: (yield* reviewer.info).foundation,
					tester: (yield* tester.info).foundation,
				};
				return { explanation, review, tests, followUp, info };
			}).pipe(
				Effect.provide(
					Harness.layer({
						home: join(root, "home"),
						hostCwd: root,
						database: ":memory:",
						userConfigDir: custom,
						plugins: [],
					}),
				),
				Effect.scoped,
				Effect.timeout("240 seconds"),
				Effect.runPromise,
			);

			const opensWith = (text: string) =>
				text.startsWith("REVIEW:") ? "REVIEW:" : text.startsWith("TESTS:") ? "TESTS:" : "none";
			// Requests in order: main, reviewer, tester, main.
			const foundations = bodies.map((body) =>
				body.includes("strict code reviewer")
					? "reviewer"
					: body.includes("You write unit tests")
						? "tester"
						: "default",
			);
			const artifact = {
				replies: {
					main: opensWith(result.explanation),
					reviewer: opensWith(result.review),
					tester: opensWith(result.tests),
					mainAfterForks: opensWith(result.followUp),
				},
				requestFoundations: foundations,
				info: {
					main: result.info.main === undefined ? "default" : "own",
					reviewer: result.info.reviewer === REVIEWER ? "reviewer" : "other",
					tester: result.info.tester === TESTER ? "tester" : "other",
				},
			};
			expect(artifact.replies).toEqual({
				main: "none",
				reviewer: "REVIEW:",
				tester: "TESTS:",
				mainAfterForks: "none",
			});
			expect(foundations).toEqual(["default", "reviewer", "tester", "default"]);
			expect(artifact.info).toEqual({ main: "default", reviewer: "reviewer", tester: "tester" });
			await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
				`./__artifacts__/prompt.foundation.live.${name}.json`,
			);
		}),
	);
});
