/* @effect-diagnostics nodeBuiltinImport:off -- a CodeWork server run as its own process by the sync suite. */
import { createAssistantMessageEventStream, type Message } from "@codeworksh/aikit";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { createInterface } from "node:readline";
import { assistant } from "../../../../packages/harness/test/fixtures/llm.ts";
import type * as LLM from "../../../../packages/harness/src/runner/llm.ts";
import * as Server from "../../../../packages/codework/src/server/server.ts";
import { Control, Harness } from "../../../../packages/harness/src/effect.ts";

/*
 * `node --conditions=development codework.ts <home> <port> [host] [sweep]`: a real CodeWork server
 * in `home` on `port` (bound to `host`, 127.0.0.1 unless given), with a scripted model. A prompt's
 * text picks the reply:
 * - `gate`: "Hello " | "wor" | "ld" | "!" | end, held before each step after the first;
 * - `hold`: held after its start, until interrupted;
 * - `long <n>`: n chunks of 32 characters, one every 10 ms;
 * - anything else: `reply to <text>`, at once.
 * Each line `release` on stdin lets the oldest held reply take its next step.
 * With `sweep`, it only ends the runs the last server left open, as a start does before it listens,
 * prints `swept` and exits: the store can then be read as no client has seen it.
 */

const [home, port, host = "127.0.0.1", mode] = process.argv.slice(2);
if (home === undefined || port === undefined) throw new Error("usage: codework.ts <home> <port> [host] [sweep]");

const waiting: Array<() => void> = [];
let credits = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
	if (line.trim() !== "release") return;
	const next = waiting.shift();
	if (next === undefined) credits += 1;
	else next();
});
const gate = () =>
	new Promise<void>((resolve) => {
		if (credits > 0) {
			credits -= 1;
			resolve();
		} else waiting.push(resolve);
	});

const promptOf = (input: LLM.Input) => {
	const user = input.context.messages.findLast((message) => message.role === "user");
	return user?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? "";
};

// Ids unique across restarts of this process: entry ids are the reply's message ids.
let count = 0;
const scripted: LLM.Open = (input, signal) =>
	Effect.sync(() => {
		count += 1;
		const index = count;
		const messageId = `assistant_${process.pid}_${index}`;
		const text = promptOf(input);
		const long = /^long (\d+)$/.exec(text);
		const chunks =
			text === "gate"
				? ["Hello ", "wor", "ld", "!"]
				: text === "hold"
					? []
					: long !== null
						? Array.from({ length: Number(long[1]) }, (_, step) =>
								`chunk ${String(step).padStart(5, "0")} `.padEnd(32, "."),
							)
						: [`reply to ${text}`];
		const message = assistant(input, index, { messageId, parts: [{ type: "text", text: chunks.join("") }] });
		const partial = assistant(input, index, { messageId, parts: [] });
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial });
		// A stop ends the reply as aborted, as a provider's would.
		signal.addEventListener(
			"abort",
			() =>
				events.push({
					type: "error",
					reason: "aborted",
					error: assistant(input, index, { messageId, stopReason: "aborted", parts: [] }),
				}),
			{ once: true },
		);
		void (async () => {
			if (text === "hold") return;
			const part = { type: "text" as const, text: "" };
			partial.parts.push(part);
			events.push({ type: "text.start", partIndex: 0, partial });
			for (const [step, delta] of chunks.entries()) {
				if (text === "gate" && step > 0) await gate();
				if (long !== null) await new Promise((resolve) => setTimeout(resolve, 10));
				part.text += delta;
				events.push({ type: "text.delta", partIndex: 0, delta, partial });
			}
			if (text === "gate") await gate();
			events.push({ type: "text.end", partIndex: 0, content: part.text, partial });
			events.push({ type: "done", reason: "stop", message: message as Message.AssistantMessage });
		})();
		return events;
	});

const harness = { home, hostCwd: home, plugins: [], llm: scripted };

NodeRuntime.runMain(
	mode === "sweep"
		? Effect.gen(function* () {
				yield* Effect.flatMap(Control.Service, (control) => control.sweep).pipe(
					Effect.provide(Harness.layer(harness)),
				);
				yield* Effect.sync(() => process.stdout.write(`${JSON.stringify({ type: "swept" })}\n`));
			})
		: Effect.gen(function* () {
				yield* Layer.build(Server.layer({ host, port: Number(port), harness }));
				yield* Effect.sync(() => process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`));
				return yield* Effect.never;
			}).pipe(Effect.scoped),
);
