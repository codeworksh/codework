import { type Message, Transcript } from "@codeworksh/aikit";
import "./utils/env.ts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { define, Section } from "../src/plugin/index.ts";
import { immediateOpen } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";

const Mode = Section.define("mode");

/** A section's text only where the test sets it; the rest depend on the machine. */
const shown = (sections: Message.SystemMessage["sections"]) =>
	Object.fromEntries(
		Object.entries(sections ?? {}).map(([name, value]) => [name, name === Mode.name || value === null ? value : "…"]),
	);

/** What each request carried: its roles, and the section patch of every system message in it. */
const request = (context: Message.Context) => ({
	roles: context.messages.map((message) => message.role),
	declared: context.messages.flatMap((message) => (message.role === "system" ? [shown(message.sections)] : [])),
	mode: /<mode>\n([\s\S]*?)\n<\/mode>/.exec(Transcript.getCurrentSystemPrompt(context))?.[1] ?? null,
});

/** The developer messages a model with in-place system messages gets: the head, then each update. */
const inPlace = (context: Message.Context) => {
	const prompt = Transcript.resolveTranscriptPrompt(context, true);
	const updates = context.messages
		.filter((message): message is Message.SystemMessage => message.role === "system")
		.slice(prompt.foldedSystemMessages)
		.map(Transcript.renderSystemPromptUpdate);
	return [prompt.systemPrompt, ...updates];
};

const isPrefix = (head: ReadonlyArray<string>, whole: ReadonlyArray<string>) =>
	head.every((value, index) => whole[index] === value);

describe("prompt sections across prompts", () => {
	it("declares every section once, then only what changed, through resume and fork", () =>
		withSettings(async ({ root }) => {
			const contexts: Message.Context[] = [];
			// One open for both runtimes: its reply ids count on across them.
			const open = immediateOpen(contexts);
			const state: { mode: string | undefined } = { mode: "Plan only." };
			const runtime = () =>
				Harness.layer({
					home: join(root, "home"),
					hostCwd: root,
					database: join(root, "sessions.db"),
					llm: open,
					plugins: [
						defaultPromptPlugin,
						define({
							id: "acme.prompt.mode",
							kind: "prompt",
							setup: (ctx) => {
								if (state.mode !== undefined) ctx.plugin.prompt.sections.append(Mode, state.mode);
							},
						}),
					],
				});
			const types = (history: ReadonlyArray<{ readonly entry: { readonly type: string } }>) =>
				history.map(({ entry }) => entry.type);

			const sessionId = await Effect.runPromise(
				Effect.gen(function* () {
					const { id, main } = yield* Session.create({ directory: root });
					yield* main.run("one");
					state.mode = "Build allowed.";
					yield* main.run("two");
					state.mode = undefined;
					yield* main.run("three");
					yield* main.run("four");
					return id;
				}).pipe(Effect.provide(runtime()), Effect.scoped),
			);

			const threads = await Effect.runPromise(
				Effect.gen(function* () {
					const main = yield* Session.attach({ sessionId });
					// Resumed in a new process with nothing changed: the transcript already declares it all.
					yield* main.run("five");
					// A removed section added again is declared again.
					state.mode = "Plan again.";
					yield* main.run("six");
					state.mode = undefined;
					const history = yield* main.history();
					// Cut after the first reply, whose transcript still has the plan-only section.
					const firstReply = history.find(({ entry }) => entry.type === "assistant")!;
					const { thread: fork } = yield* main.fork({ entryId: firstReply.entry.id });
					yield* fork.run("seven");
					return { main: types(yield* main.history()), fork: types(yield* fork.history()) };
				}).pipe(Effect.provide(runtime()), Effect.scoped),
			);

			const requests = contexts.map(request);
			// Each request extends the one before it, so a model taking changes in place keeps its prefix.
			const prefixKept = contexts
				.slice(1, 6)
				.map((context, index) => isPrefix(inPlace(contexts[index]!), inPlace(context)));
			expect(prefixKept).toEqual([true, true, true, true, true]);
			expect(requests.map(({ mode }) => mode)).toEqual([
				"Plan only.",
				"Build allowed.",
				null,
				null,
				null,
				"Plan again.",
				null,
			]);
			await expect(JSON.stringify({ requests, prefixKept, threads }, null, "\t")).toMatchFileSnapshot(
				"./__artifacts__/prompt.changes.json",
			);
		}));
});
