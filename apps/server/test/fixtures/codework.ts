/* @effect-diagnostics nodeBuiltinImport:off -- a CodeWork server run as its own process by the sync suite. */
import { createAssistantMessageEventStream, type Message } from "@codeworksh/aikit";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { assistant as scriptedAssistant } from "../../../../packages/harness/test/fixtures/llm.ts";
import { testModel } from "../../../../packages/harness/test/fixtures/model.ts";
import type * as LLM from "../../../../packages/harness/src/runner/llm.ts";
import * as Clones from "../../../../packages/codework/src/server/clones.ts";
import * as Contract from "../../../../packages/codework/src/server/contract.ts";
import * as EventFeed from "../../../../packages/codework/src/server/feed.ts";
import * as Handlers from "../../../../packages/codework/src/server/handlers.ts";
import * as Host from "../../../../packages/codework/src/server/host.ts";
import * as Identity from "../../../../packages/codework/src/server/identity.ts";
import * as OAuth from "../../../../packages/codework/src/server/oauth.ts";
import * as Server from "../../../../packages/codework/src/server/server.ts";
import { Control, Harness } from "../../../../packages/harness/src/effect.ts";
import { bashPlugin } from "../../../../packages/harness/src/plugin/builtin/tool/bash.ts";
import * as DaytonaDriver from "../../../../packages/harness/src/sandboxes/daytona/index.ts";

/*
 * `node --conditions=development codework.ts <home> <port> [host] [sweep]`: a real CodeWork server
 * in `home` on `port` (bound to `host`, 127.0.0.1 unless given), with a scripted model. A prompt's
 * text picks the reply:
 * - `gate`: "Hello " | "wor" | "ld" | "!" | end, held before each step after the first;
 * - `hold`: held after its start, until interrupted;
 * - `long <n>`: n chunks of 32 characters, one every 10 ms;
 * - `bash <command>`: one `bash` tool call running `command`, then `done` once its result is back;
 * - anything else: `reply to <text>`, at once.
 * Each line `release` on stdin lets the oldest held reply take its next step.
 * With `sweep`, it only ends the runs the last server left open, as a start does before it listens,
 * prints `swept` and exits: the store can then be read as no client has seen it.
 * With `older`, it serves every call but `usage.sync`, and names no host, as a server built before it did.
 * It reports its host as `CODEWORK_FIXTURE_HOST` (none when blank), else `Fixture`: never this computer's name,
 * unless `CODEWORK_FIXTURE_HOST_OS=1`, which a live machine sets to report its own name as a real server does.
 */

const [home, port, host = "127.0.0.1", mode] = process.argv.slice(2);
if (home === undefined || port === undefined) throw new Error("usage: codework.ts <home> <port> [host] [sweep]");

// No provider is configured here, so a run needs settings to name its model; the scripted one answers.
const settings = join(home, "settings.jsonc");
if (!existsSync(settings)) {
	mkdirSync(home, { recursive: true });
	writeFileSync(settings, JSON.stringify({ model: testModel }));
}

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

/** The `bash <command>` a prompt asks for, unless its call was already made. */
const bashOf = (input: LLM.Input) => {
	const messages = input.context.messages;
	const last = messages.findLastIndex((message) => message.role === "user");
	if (messages.slice(last + 1).some((message) => message.role === "assistant")) return undefined;
	return /^bash (.+)$/s.exec(promptOf(input))?.[1];
};

// With `CODEWORK_FIXTURE_NOW=1` a reply took the last 1.5 s of real time, so usage lands in today's
// hours; otherwise its times are its index, in the first hour of 1970, the same on every run.
const assistant: typeof scriptedAssistant = (input, index, overrides) =>
	scriptedAssistant(input, index, {
		...(process.env.CODEWORK_FIXTURE_NOW === "1"
			? { time: { created: Date.now() - 1_500, completed: Date.now() } }
			: {}),
		...overrides,
	});

// Ids unique across restarts of this process: entry ids are the reply's message ids.
let count = 0;
const scripted: LLM.Open = (input, signal) =>
	Effect.sync(() => {
		count += 1;
		const index = count;
		const messageId = `assistant_${process.pid}_${index}`;
		const text = promptOf(input);
		const command = bashOf(input);
		if (command !== undefined || text.startsWith("bash ")) {
			const reply =
				command === undefined
					? assistant(input, index, { messageId, parts: [{ type: "text", text: "done" }] })
					: assistant(input, index, {
							messageId,
							stopReason: "toolUse",
							parts: [
								{
									type: "toolCall",
									callID: `call_${process.pid}_${index}`,
									name: "bash",
									arguments: { command },
									status: "pending",
									time: { start: index, end: index },
								},
							],
						});
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: reply });
			stream.push({ type: "done", reason: command === undefined ? "stop" : "toolUse", message: reply });
			return stream;
		}
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

// A remote sandbox driver when this machine was given its credentials.
const sandboxes = process.env.DAYTONA_API_KEY?.trim() ? [DaytonaDriver.make()] : [];
// Only the bash tool: the scripted model's `bash <command>` prompts call it, and nothing else varies the prompt.
const harness = { home, hostCwd: home, plugins: [bashPlugin], llm: scripted, sandboxes };

const named = process.env.CODEWORK_FIXTURE_HOST ?? "Fixture";
const identity =
	process.env.CODEWORK_FIXTURE_HOST_OS === "1"
		? Identity.layer
		: Layer.succeed(
				Identity.Service,
				Identity.Service.of(named === "" ? Identity.current : { ...Identity.current, host: { name: named } }),
			);

/** The RPC server alone, without the calls a server older than this build lacks. */
const older = HttpRouter.serve(
	RpcServer.layerHttp({ group: Contract.Api.omit("usage.sync"), path: Contract.path, protocol: "websocket" }).pipe(
		Layer.provide(Handlers.layer.pipe(Layer.provide(EventFeed.layer))),
	),
	{ disableListenLog: true },
).pipe(
	Layer.provide(OAuth.layer({ home })),
	Layer.provide(Host.layer),
	Layer.provide(Clones.layer),
	Layer.provide(NodeHttpServer.layer(createServer, { host, port: Number(port) })),
	Layer.provide(RpcSerialization.layerNdjson),
	Layer.provide(Layer.succeed(Identity.Service, Identity.current)),
	Layer.provide(Harness.layer(harness)),
);

NodeRuntime.runMain(
	mode === "sweep"
		? Effect.gen(function* () {
				yield* Effect.flatMap(Control.Service, (control) => control.sweep).pipe(
					Effect.provide(Harness.layer(harness)),
				);
				yield* Effect.sync(() => process.stdout.write(`${JSON.stringify({ type: "swept" })}\n`));
			})
		: Effect.gen(function* () {
				yield* Layer.build(
					mode === "older" ? older : Server.layer({ host, port: Number(port), harness, identity }),
				);
				yield* Effect.sync(() => process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`));
				return yield* Effect.never;
			}).pipe(Effect.scoped),
);
