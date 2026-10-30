import "./utils/env.ts";
import { createAssistantMessageEventStream, type Message } from "@codeworksh/aikit";
import { DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Context } from "../src/context/context.ts";
import { Control } from "../src/control.ts";
import { Database } from "../src/db/db.ts";
import { Document } from "../src/document/document.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { EventRegistry } from "../src/event/registry.ts";
import { Global } from "../src/global.ts";
import { builtins } from "../src/plugin/builtin.ts";
import { DEFAULT_LIMIT, TOOL_SEARCH_NAME, toolSearchPlugin } from "../src/plugin/builtin/tool/toolsearch.ts";
import type { Plugin } from "../src/plugin/plugin.ts";
import { RunnerExecute } from "../src/runner/execute.ts";
import { Hooks } from "../src/runner/hooks.ts";
import { LLM } from "../src/runner/llm.ts";
import { Loop } from "../src/runner/loop.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxDriverRegistry } from "../src/sandbox/registry.ts";
import { PromptSchema } from "../src/session/prompt/schema.ts";
import { SessionProjector } from "../src/session/projector.ts";
import { SessionRuntime } from "../src/session/runtime.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { Settings } from "../src/settings/settings.ts";
import { State } from "../src/state/state.ts";
import { ThreadSchema } from "../src/thread/schema.ts";
import { Thread } from "../src/thread/thread.ts";
import * as Tool from "../src/tool/tool.ts";
import { assistant, sectionNames } from "./fixtures/llm.ts";
import { pooled } from "./fixtures/pool.ts";
import { seedSpace } from "./fixtures/space.ts";
import { testEffect } from "./utils/effect.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { Process } from "../src/sandbox/utils/process.ts";

/**
 * `toolsearch` end to end, against a scripted model: what a search loads, how the next request
 * learns of it (a transcript `system` message, never a new `tools` list), what a fork keeps, and
 * what calling a tool the thread does not offer returns.
 */

interface Call {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}
/** What the model does on a thread's next request: call tools, or reply and stop. */
type Step = { readonly _tag: "call"; readonly calls: ReadonlyArray<Call> } | { readonly _tag: "reply" };

const call = (...calls: ReadonlyArray<Call>): Step => ({ _tag: "call", calls });
const reply: Step = { _tag: "reply" };
const search = (query: string, limit?: number): Call => ({
	name: TOOL_SEARCH_NAME,
	arguments: limit === undefined ? { query } : { query, limit },
});

const script = new Map<string, Array<Step>>();
const requests: Array<{ readonly threadId: string; readonly context: Message.Context }> = [];
let responses = 0;

const open: LLM.Open = (input) =>
	Effect.sync(() => {
		const step = script.get(input.threadId)?.shift() ?? reply;
		requests.push({ threadId: input.threadId, context: input.context });
		responses += 1;
		const message = assistant(
			input,
			responses,
			step._tag === "call"
				? {
						stopReason: "toolUse",
						parts: step.calls.map((one, index) => ({
							type: "toolCall" as const,
							callID: `call_${responses}_${index + 1}`,
							name: one.name,
							arguments: one.arguments,
							status: "pending" as const,
							time: { start: 1, end: 1 },
						})),
					}
				: {},
		);
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: step._tag === "call" ? "toolUse" : "stop", message });
		return stream;
	});

const text = (description: string) => Schema.String.annotate({ description });

const deferred = (name: string, description: string, parameters: Schema.Struct.Fields) =>
	Tool.register(
		Tool.make({
			name,
			description,
			exposure: "deferred",
			parameters: Schema.Struct(parameters),
			success: Schema.String,
			encodeContent: (value: string) => [{ type: "text", text: value }],
			handler: () => Effect.succeed(`${name} ran`),
		}),
	);

/** Ten deferred tools, one direct one, and two (codemode, hidden) a search must never load. */
const catalog: Plugin = {
	id: "test.tool.catalog",
	kind: "tool",
	setup: (ctx) => {
		const tools = [
			deferred("weather_forecast", "Get the weather forecast for a city.\nReturns daily highs and lows.", {
				city: text("City to get the weather forecast for"),
				days: Schema.optional(Schema.Finite.annotate({ description: "Number of forecast days" })),
			}),
			deferred("calendar_create_event", "Create an event in the user's calendar.", {
				title: text("Event title"),
				start: text("Start time as an ISO date"),
			}),
			deferred("github_create_issue", "Create an issue in a GitHub repository.", {
				repository: text("Repository as owner/name"),
				title: text("Issue title"),
			}),
			deferred("github_list_pull_requests", "List open pull requests of a GitHub repository.", {
				repository: text("Repository as owner/name"),
			}),
			deferred("slack_send_message", "Send a message to a Slack channel.", {
				channel: text("Channel to send the message to"),
				message: text("Message text"),
			}),
			deferred("jira_search_issues", "Search Jira issues with a JQL query.", {
				query: text("JQL query to search issues with"),
			}),
			deferred("email_send", "Send an email message to a recipient.", {
				to: text("Recipient email address"),
				body: text("Message body"),
			}),
			deferred("translate_text", "Translate text between languages.", {
				text: text("Text to translate"),
				target: text("Target language code"),
			}),
			deferred("stock_quote", "Get the latest stock quote for a ticker symbol.", {
				symbol: text("Ticker symbol to get a quote for"),
			}),
			deferred("database_query", "Run a read-only SQL query against the analytics database.", {
				sql: text("SQL query to run"),
			}),
		];
		for (const tool of tools) ctx.plugin.tools.add(tool);
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "notes_read",
					description: "Read the user's notes.",
					parameters: Schema.Struct({}),
					success: Schema.String,
					encodeContent: (value: string) => [{ type: "text", text: value }],
					handler: () => Effect.succeed("notes"),
				}),
			),
		);
		for (const exposure of ["codemode", "hidden"] as const) {
			ctx.plugin.tools.add(
				Tool.register(
					Tool.make({
						name: `weather_${exposure}`,
						description: "Get the weather forecast for a city, issue, message, query, quote or event.",
						exposure,
						parameters: Schema.Struct({ city: text("City to get the weather forecast for") }),
						success: Schema.String,
						handler: () => Effect.succeed("never"),
					}),
				),
			);
		}
	},
};

const layer = () => {
	const database = Database.layer(":memory:");
	const sandbox = SandboxController.layer({ hostCwd: "/" }).pipe(
		Layer.provideMerge(SandboxDriverRegistry.layer()),
		Layer.provideMerge(database),
	);
	// toolsearch ships off (`optIn`); this selection turns it on.
	const seeded = pooled([
		...builtins.filter((plugin) => plugin.id !== toolSearchPlugin.id),
		{ ...toolSearchPlugin, optIn: false },
		catalog,
	]);
	return Control.layer.pipe(
		Layer.provideMerge(
			RunnerExecute.layer.pipe(
				Layer.provide(Loop.layer({ request: LLM.make(open) }).pipe(Layer.provide(Hooks.layer))),
			),
		),
		Layer.provideMerge(State.layer({}, seeded.ref, seeded.references, seeded.follow, seeded.rebuild)),
		Layer.provideMerge(Mcp.layer({ hostCwd: "/", home: "/unused/home" }).pipe(Layer.provide(Process.host))),
		Layer.provideMerge(SessionRuntime.layer),
		Layer.provideMerge(Layer.succeed(Settings.Service, { load: () => Effect.succeed(Settings.defaults) })),
		Layer.provideMerge(sandbox),
		Layer.provideMerge(Context.layer),
		Layer.provideMerge(SessionProjector.layer),
		Layer.provideMerge(Session.storeLayer),
		Layer.provideMerge(Event.layer),
		Layer.provideMerge(EventRegistry.layer()),
		Layer.provideMerge(database),
		Layer.provideMerge(Layer.succeed(Global.Service, Global.make({ home: "/unused/home" }))),
	);
};

const { effect: it } = testEffect(layer());

const reset = Effect.sync(() => {
	script.clear();
	requests.length = 0;
	responses = 0;
});

const createSession = Effect.gen(function* () {
	const sessions = yield* Session.Service;
	const { spaceId, location } = yield* seedSpace({ location: process.cwd(), projectId: "p" });
	const { session, thread } = yield* sessions.create({ spaceId, directory: location });
	return { sessionId: SessionSchema.ID.make(session.id), main: ThreadSchema.ID.make(thread.id) };
});

const run = (sessionId: SessionSchema.ID, threadId: ThreadSchema.ID, prompt: string, steps: ReadonlyArray<Step>) =>
	Effect.gen(function* () {
		script.set(threadId, [...steps]);
		const control = yield* Control.Service;
		yield* control.run({ sessionId, threadId, prompt: PromptSchema.Prompt.fromText(prompt), delivery: "followUp" });
	});

/**
 * A request as the model saw it: its declared tools, and the section names and tool changes its
 * system messages carry.
 */
const sent = (context: Message.Context) => ({
	tools: (context.tools ?? []).map((tool) => tool.name),
	system: context.messages.flatMap((message) =>
		message.role === "system"
			? [
					{
						sections: sectionNames(message.sections),
						added: (message.toolsAdded ?? []).map((tool) => tool.name),
						removed: (message.toolsRemoved ?? []).map((tool) => tool.name),
					},
				]
			: [],
	),
});
const requestsOf = (threadId: string) => requests.filter((one) => one.threadId === threadId).map((one) => one.context);

/** Every settled tool call on a thread's line, as the model reads it back. */
const results = Effect.fnUntraced(function* (threadId: ThreadSchema.ID) {
	const threads = yield* Thread.Service;
	const line = yield* threads.line(threadId);
	const messages = yield* Effect.forEach(
		line.filter(({ entry }) => entry.type === "assistant" && entry.threadId === threadId),
		ContextCodec.decodeMessage,
	);
	return messages.flatMap((message) =>
		ContextCodec.parts(message).flatMap((part) =>
			part.type === "toolCall" && part.status !== "pending" && part.status !== "running"
				? [
						{
							name: part.name,
							arguments: part.arguments,
							status: part.status,
							text: part.result.content.flatMap((one) => (one.type === "text" ? [one.text] : [])).join(""),
							details: part.result.details,
						},
					]
				: [],
		),
	);
});

/** A system entry's data, its sections by name only. */
const systemData = (data: string) => {
	const { sections, ...rest } = JSON.parse(data) as { readonly sections?: Record<string, string | null> };
	return { ...(sections === undefined ? {} : { sections: sectionNames(sections) }), ...rest };
};

/** The thread's events, entries and `agent` revisions, by seq; ids aliased in order seen. */
const ledger = Effect.fnUntraced(function* (sessionId: SessionSchema.ID, threadId: ThreadSchema.ID) {
	const sql = yield* SqlClient.SqlClient;
	const aliases = new Map<string, string>();
	const alias = (id: string) => {
		const known = aliases.get(id);
		if (known !== undefined) return known;
		const name = `E${aliases.size + 1}`;
		aliases.set(id, name);
		return name;
	};
	const events = yield* sql<{ seq: number; type: string; data: string }>`
		SELECT seq, type, data FROM event WHERE aggregate_id = ${sessionId} ORDER BY seq
	`;
	const entries = yield* sql<{ id: string; seq: number; type: string; state: string; data: string }>`
		SELECT id, seq, type, state, data FROM entry WHERE thread_id = ${threadId} ORDER BY seq
	`;
	const revisions = yield* sql<{ seq: number; value: string }>`
		SELECT revision.seq, revision.value FROM revision JOIN document ON document.id = revision.document_id
		WHERE document.thread_id = ${threadId} AND document.kind = 'agent' ORDER BY revision.seq
	`;
	return {
		events: events
			.filter((event) => (JSON.parse(event.data) as { readonly threadId?: string }).threadId === threadId)
			.map((event) => ({ seq: event.seq, type: event.type })),
		entries: entries.map((entry) => ({
			id: alias(entry.id),
			seq: entry.seq,
			type: entry.type,
			state: entry.state,
			...(entry.type === "system" ? { data: systemData(entry.data) } : {}),
		})),
		agent: revisions.map((revision) => ({ seq: revision.seq, value: JSON.parse(revision.value) as unknown })),
	};
});
type Ledger = Effect.Success<ReturnType<typeof ledger>>;

/** The first request's system message: every prompt section, no tool change. */
const prompt = { sections: ["tools", "rules", "cwd"], added: [], removed: [] };

const systemEntries = (book: Ledger) => book.entries.filter((entry) => entry.type === "system");
const settledSeqs = (book: Ledger) =>
	book.events.filter((event) => event.type.startsWith(`${EventList.ToolSettled.type}.`)).map((event) => event.seq);

const artifact = (name: string, value: unknown) =>
	Effect.promise(() =>
		expect(`${JSON.stringify(value, null, "\t")}\n`).toMatchFileSnapshot(`./__artifacts__/${name}`),
	);

describe("toolsearch", () => {
	it(
		"loads a tool: the agent revision lands at the settle, the next request declares it by a system message",
		Effect.gen(function* () {
			yield* reset;
			const { sessionId, main } = yield* createSession;
			yield* run(sessionId, main, "What is the weather in Lisbon?", [
				call(search("weather forecast", 1)),
				call({ name: "weather_forecast", arguments: { city: "Lisbon" } }),
				reply,
			]);

			const [first, second, third] = requestsOf(main).map(sent);
			const outcomes = yield* results(main);
			const book = yield* ledger(sessionId, main);

			expect(outcomes[0]).toMatchObject({
				name: TOOL_SEARCH_NAME,
				status: "completed",
				text: "Loaded 1 tool. They are available from your next call:\n- weather_forecast: Get the weather forecast for a city.",
				details: { loaded: ["weather_forecast"] },
			});
			// The load is one `agent` revision, written by the settle event itself.
			const loads = book.agent.filter((revision) => JSON.stringify(revision.value).includes("weather_forecast"));
			expect(loads).toHaveLength(1);
			expect(settledSeqs(book)).toContain(loads[0]!.seq);
			expect(loads[0]!.value).toEqual({ modelTools: { add: ["weather_forecast"] } });

			// The request's `tools` never change; the loaded tool arrives as a system message.
			expect(first!.tools).toContain(TOOL_SEARCH_NAME);
			expect(first!.tools).not.toContain("weather_forecast");
			expect(second!.tools).toEqual(first!.tools);
			// The first request declares the prompt sections; loading a tool leaves them as they are.
			expect(first!.system).toEqual([prompt]);
			expect(second!.system).toEqual([prompt, { sections: [], added: ["weather_forecast"], removed: [] }]);
			// The third request replays both system entries; nothing new is declared.
			expect(third!.tools).toEqual(first!.tools);
			expect(third!.system).toEqual(second!.system);
			expect(systemEntries(book)).toHaveLength(2);
			expect(systemEntries(book)[1]!.data).toEqual({
				toolsAdded: [expect.objectContaining({ name: "weather_forecast" })],
				toolsRemoved: [],
				hash: expect.any(String),
			});
			// The loaded tool runs.
			expect(outcomes[1]).toMatchObject({
				name: "weather_forecast",
				status: "completed",
				text: "weather_forecast ran",
			});

			yield* artifact("tools.toolsearch.load.json", {
				requests: [first, second, third],
				results: outcomes,
				...book,
			});
		}),
	);

	it(
		"refuses an empty query and a bad limit, and reports no matches",
		Effect.gen(function* () {
			yield* reset;
			const { sessionId, main } = yield* createSession;
			yield* run(sessionId, main, "Find me tools", [
				call(search("   "), search("weather", 0), search("weather", 1.5), search("zebra xylophone")),
				reply,
			]);
			const outcomes = yield* results(main);
			const book = yield* ledger(sessionId, main);

			expect(outcomes.map((one) => [one.status, one.text])).toEqual([
				["error", "query must not be empty"],
				["error", "limit must be a positive integer"],
				["error", "limit must be a positive integer"],
				["completed", "No matching tools found."],
			]);
			for (const failed of outcomes.slice(0, 3)) expect(failed.details).toMatchObject({ _tag: "ToolSearchFailed" });
			expect(outcomes[3]!.details).toEqual({ loaded: [] });
			// Nothing loaded: no `agent` change and no system entry past the first request's prompt.
			expect(book.agent.some((revision) => JSON.stringify(revision.value).includes("modelTools"))).toBe(false);
			expect(systemEntries(book)).toHaveLength(1);
			expect(
				requestsOf(main)
					.map(sent)
					.map((one) => one.system),
			).toEqual([[prompt], [prompt]]);
			yield* artifact("tools.toolsearch.refused.json", { results: outcomes, agent: book.agent });
		}),
	);

	it(
		"returns at most `limit` tools, best first, and 8 by default",
		Effect.gen(function* () {
			yield* reset;
			const { sessionId, main } = yield* createSession;
			// Both run against the same request's candidates: all ten deferred tools.
			const broad = "create send search list get query translate run weather issue message quote event";
			yield* run(sessionId, main, "Find me tools", [call(search("github issue", 2), search(broad)), reply]);
			const [limited, all] = yield* results(main);
			const loadedOf = (details: unknown) => (details as { readonly loaded: ReadonlyArray<string> }).loaded;

			expect(loadedOf(limited!.details)).toEqual(["github_create_issue", "jira_search_issues"]);
			expect(loadedOf(all!.details)).toHaveLength(DEFAULT_LIMIT);
			for (const never of ["weather_codemode", "weather_hidden", "notes_read", TOOL_SEARCH_NAME])
				expect(loadedOf(all!.details)).not.toContain(never);
			// Both loads are on the agent, the second appended after the first.
			const add = (yield* (yield* Document.Service).agent(main)).modelTools?.add ?? [];
			expect(add.slice(0, 2)).toEqual(loadedOf(limited!.details));
			expect(new Set(add)).toEqual(new Set([...loadedOf(limited!.details), ...loadedOf(all!.details)]));
			const [, next] = requestsOf(main).map(sent);
			expect(next!.system).toEqual([prompt, { sections: [], added: add, removed: [] }]);

			yield* artifact("tools.toolsearch.limit.json", {
				results: [limited, all],
				agentAdd: add,
				nextRequest: next,
			});
		}),
	);

	it(
		"a fork cut before the load does not offer the tool; one cut at the load does",
		Effect.gen(function* () {
			yield* reset;
			const threads = yield* Thread.Service;
			const documents = yield* Document.Service;
			const { sessionId, main } = yield* createSession;
			yield* run(sessionId, main, "Load the forecast tool", [call(search("weather forecast", 1)), reply]);
			const line = yield* threads.line(main);
			expect(line.map(({ entry }) => entry.type)).toEqual(["system", "user", "assistant", "system", "assistant"]);
			const [, asked, searched] = line;

			const before = ThreadSchema.ID.make(
				(yield* threads.fork({ threadId: main, entryId: asked!.entry.id })).thread.id,
			);
			const after = ThreadSchema.ID.make(
				(yield* threads.fork({ threadId: main, entryId: searched!.entry.id })).thread.id,
			);
			const beforeAgent = yield* documents.agent(before);
			const afterAgent = yield* documents.agent(after);
			expect(beforeAgent.modelTools).toBeUndefined();
			expect(afterAgent.modelTools).toEqual({ add: ["weather_forecast"] });

			const weather: Call = { name: "weather_forecast", arguments: { city: "Porto" } };
			yield* run(sessionId, before, "Weather in Porto?", [call(weather), reply]);
			yield* run(sessionId, after, "Weather in Porto?", [call(weather), reply]);

			const [beforeFirst] = requestsOf(before).map(sent);
			const [afterFirst] = requestsOf(after).map(sent);
			const beforeResults = yield* results(before);
			const afterResults = yield* results(after);
			// Cut before main's first system entry, the fork declares the prompt itself.
			expect(beforeFirst!.system).toEqual([prompt]);
			expect(beforeResults[0]).toMatchObject({
				status: "error",
				text: 'Tool "weather_forecast" is not available in this thread.',
				details: { _tag: "ToolUnavailable", name: "weather_forecast" },
			});
			// The history up to the cut declares the prompt but not the tool; the fork declares the tool itself.
			expect(afterFirst!.system).toEqual([prompt, { sections: [], added: ["weather_forecast"], removed: [] }]);
			expect(afterResults[0]).toMatchObject({ status: "completed", text: "weather_forecast ran" });
			const afterBook = yield* ledger(sessionId, after);
			expect(systemEntries(afterBook)).toHaveLength(1);

			yield* artifact("tools.toolsearch.fork.json", {
				before: { agent: beforeAgent, firstRequest: beforeFirst, results: beforeResults },
				after: { agent: afterAgent, firstRequest: afterFirst, results: afterResults, entries: afterBook.entries },
			});
		}),
	);

	it(
		"calling an unloaded deferred tool or a removed declared tool is unavailable",
		Effect.gen(function* () {
			yield* reset;
			const events = yield* Event.Service;
			const { sessionId, main } = yield* createSession;
			yield* events.publish(EventList.ThreadConfigured, {
				timestamp: yield* DateTime.now,
				sessionId,
				threadId: main,
				change: { modelTools: { remove: ["notes_read"] } },
			});
			yield* run(sessionId, main, "Read my notes and the weather", [
				call(
					{ name: "notes_read", arguments: {} },
					{ name: "stock_quote", arguments: { symbol: "ACME" } },
					{ name: "no_such_tool", arguments: {} },
				),
				reply,
			]);
			const outcomes = yield* results(main);
			const book = yield* ledger(sessionId, main);

			expect(outcomes.map((one) => [one.name, one.status, one.text, one.details])).toEqual([
				[
					"notes_read",
					"error",
					'Tool "notes_read" is not available in this thread.',
					{ _tag: "ToolUnavailable", name: "notes_read" },
				],
				[
					"stock_quote",
					"error",
					'Tool "stock_quote" is not available in this thread.',
					{ _tag: "ToolUnavailable", name: "stock_quote" },
				],
				["no_such_tool", "error", "Unknown Tool: no_such_tool", { error: "unknown-tool", name: "no_such_tool" }],
			]);
			const [first] = requestsOf(main).map(sent);
			yield* artifact("tools.toolsearch.unavailable.json", {
				firstRequest: first,
				results: outcomes,
				entries: book.entries,
			});
			// The removal is declared to the model as a system entry.
			expect(systemEntries(book)).toHaveLength(1);
			expect(systemEntries(book)[0]!.data).toMatchObject({
				sections: prompt.sections,
				toolsRemoved: [{ name: "notes_read" }],
			});
		}),
	);
});
