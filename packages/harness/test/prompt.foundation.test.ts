import type { Message } from "@codeworksh/aikit";
import "./utils/env.ts";
import { Effect } from "effect";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { immediateOpen } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";

const REVIEWER = "You are a code reviewer.";
const SCOUT = "You are a scout.";

/** The foundation a request led with, by the persona it names, and how many section declarations it carried. */
const request = (context: Message.Context) => ({
	foundation: context.systemPrompt === REVIEWER ? "reviewer" : context.systemPrompt === SCOUT ? "scout" : "default",
	declarations: context.messages.filter((message) => message.role === "system").length,
});

describe("a thread's own prompt foundation", () => {
	it("leads only that thread's requests, follows forks as of the cut, survives a restart and clears", () =>
		withSettings(async ({ root }) => {
			const contexts: Message.Context[] = [];
			// One open for both runtimes: its reply ids count on across them.
			const open = immediateOpen(contexts);
			const runtime = () =>
				Harness.layer({
					home: join(root, "home"),
					hostCwd: root,
					database: join(root, "sessions.db"),
					llm: open,
					plugins: [defaultPromptPlugin],
				});
			const steps: Array<{ step: string; thread: string; request: ReturnType<typeof request> }> = [];
			const ran = (step: string, thread: string) => steps.push({ step, thread, request: request(contexts.at(-1)!) });

			const sessionId = await Effect.runPromise(
				Effect.gen(function* () {
					const { id, main } = yield* Session.create({ directory: root });
					yield* main.run("one");
					ran("before any choice", "main");
					const firstReply = (yield* main.history()).find(({ entry }) => entry.type === "assistant")!;

					yield* main.configure({ foundation: REVIEWER });
					yield* main.run("two");
					ran("after configuring main", "main");

					// Cut before the choice: the fork has the foundation of that point.
					const { thread: early } = yield* main.fork({ entryId: firstReply.entry.id });
					yield* early.run("three");
					ran("fork cut before the choice", "early fork");

					// Cut after it: the fork starts with main's choice, then makes its own.
					const latest = (yield* main.history()).findLast(({ entry }) => entry.type === "assistant")!;
					const { thread: late } = yield* main.fork({ entryId: latest.entry.id });
					yield* late.run("four");
					ran("fork cut after the choice", "late fork");
					yield* late.configure({ foundation: SCOUT });
					yield* late.run("five");
					ran("after configuring the fork", "late fork");
					yield* main.run("six");
					ran("main after the fork's choice", "main");
					return id;
				}).pipe(Effect.provide(runtime()), Effect.scoped),
			);

			await Effect.runPromise(
				Effect.gen(function* () {
					const main = yield* Session.attach({ sessionId });
					yield* main.run("seven");
					ran("main after a restart", "main");
					yield* main.configure({ foundation: null });
					yield* main.run("eight");
					ran("main after clearing", "main");
				}).pipe(Effect.provide(runtime()), Effect.scoped),
			);

			expect(steps.map(({ request }) => request.foundation)).toEqual([
				"default",
				"reviewer",
				"default",
				"reviewer",
				"scout",
				"reviewer",
				"reviewer",
				"default",
			]);
			// A foundation choice declares no section again: each thread's declarations stay at one.
			expect(steps.every(({ request }) => request.declarations === 1)).toBe(true);
			await expect(`${JSON.stringify(steps, null, "\t")}\n`).toMatchFileSnapshot(
				"./__artifacts__/prompt.foundation.json",
			);
		}));
});
