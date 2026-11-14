/* @effect-diagnostics nodeBuiltinImport:off -- a one-shot script run inside an OrbStack machine. */
/**
 * Fills every session of a stopped CodeWork store with a history of turns across the past `days`
 * days, through the thread store's own writes, so the usage rollup, thread totals and revisions come
 * out as a live run makes them:
 *   node --conditions=development seed.ts <database> <days> <seed> [<until ms>]
 * Each session gets a start day (a little busier recently, quieter at weekends) and 2-14 turns on its days;
 * each turn is a prompt and 1-6 requests to one model of its project's mix, the last answering and
 * the others calling tools. A few requests fail, a few are interrupted (aborted, never timed), and a
 * few calls error or are skipped. Prints one JSON line of what it wrote.
 */
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { Database, Event, EventRegistry, Usage } from "../../../../packages/harness/src/effect.ts";
import * as Document from "../../../../packages/harness/src/document/document.ts";
import * as ThreadSchema from "../../../../packages/harness/src/thread/schema.ts";
import * as Thread from "../../../../packages/harness/src/thread/thread.ts";
import type { ToolStatus } from "../../../../packages/harness/src/db/schema.sql.ts";

const [database, daysArg = "365", seedArg = "1", untilArg] = process.argv.slice(2);
if (database === undefined) throw new Error("usage: seed.ts <database> <days> <seed> [<until ms>]");
const DAYS = Number(daysArg);
const UNTIL = untilArg === undefined ? Date.now() : Number(untilArg);
const DAY = 86_400_000;

// mulberry32: the same seed writes the same history.
let state = Number(seedArg) >>> 0;
const random = () => {
	state = (state + 0x6d2b79f5) >>> 0;
	let t = state;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
const int = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
const pick = <A>(items: ReadonlyArray<A>): A => items[Math.floor(random() * items.length)]!;
const weighted = <A>(items: ReadonlyArray<readonly [A, number]>): A => {
	let left = random() * items.reduce((sum, [, weight]) => sum + weight, 0);
	for (const [item, weight] of items) if ((left -= weight) <= 0) return item;
	return items.at(-1)![0];
};
/** Right-skewed, like real response times: median `median`, rarely 10x. */
const skewed = (median: number) => Math.round(median * Math.exp((random() + random() + random() - 1.5) * 1.6));

interface Model {
	readonly provider: string;
	readonly name: string;
	readonly model: string;
	/** USD per million tokens: input, output, cache read, cache write; zero for an unpriced one. */
	readonly price: readonly [number, number, number, number];
	readonly speed: number;
}
const MODELS: ReadonlyArray<Model> = [
	{ provider: "anthropic", name: "Anthropic", model: "claude-opus-5-5", price: [5, 25, 0.5, 6.25], speed: 55 },
	{ provider: "anthropic", name: "Anthropic", model: "claude-sonnet-5-5", price: [3, 15, 0.3, 3.75], speed: 80 },
	{ provider: "anthropic", name: "Anthropic", model: "claude-haiku-5-5", price: [1, 5, 0.1, 1.25], speed: 140 },
	{ provider: "openai", name: "OpenAI", model: "gpt-6-luna", price: [1.25, 10, 0.125, 0], speed: 70 },
	{ provider: "openai-codex", name: "OpenAI Codex", model: "gpt-6-luna", price: [0, 0, 0, 0], speed: 65 },
	{ provider: "github-copilot", name: "GitHub Copilot", model: "kimi-k3", price: [0.6, 2.5, 0.15, 0], speed: 45 },
	{ provider: "openrouter", name: "OpenRouter", model: "crouton-alpha", price: [0, 0, 0, 0], speed: 90 },
];
/** Priced models are the common case; unpriced ones show up now and then. */
const pickModel = () => weighted(MODELS.map((model) => [model, model.price[0] === 0 ? 1 : 3] as const));
const THINKING = [
	["off", 2],
	["minimal", 1],
	["low", 3],
	["medium", 4],
	["high", 5],
	["xhigh", 1],
] as const;
const TOOLS = [
	["bash", 30],
	["read", 25],
	["edit", 14],
	["grep", 10],
	["write", 6],
	["glob", 5],
	["todo", 4],
	["web_fetch", 2],
	["task", 2],
] as const;
const PROMPTS = [
	"Fix the failing test in the sync suite",
	"Add a retry with backoff to the uploader",
	"Explain how the cursor resumes after a restart",
	"Refactor the settings loader into its own module",
	"Why does the sidebar flicker when a thread finishes?",
	"Write a migration that adds an index on hour",
	"Review this diff for race conditions",
	"Make the chart tooltip follow the pointer",
];

const layer = Thread.layer.pipe(
	Layer.provideMerge(Usage.layer),
	Layer.provideMerge(Document.layer),
	Layer.provideMerge(Event.layer),
	Layer.provideMerge(EventRegistry.layer()),
	Layer.provideMerge(Database.layer(database)),
);

/** A start day across the period, leaning recent, a third as busy at weekends. */
const startDay = () => {
	for (;;) {
		const ago = Math.floor(DAYS * random() ** 1.25);
		const weekday = new Date(UNTIL - ago * DAY).getUTCDay();
		if (weekday !== 0 && weekday !== 6) return ago;
		if (random() < 0.33) return ago;
	}
};

const program = Effect.gen(function* () {
	const sql = yield* Database.SqlClient.SqlClient;
	const threads = yield* Thread.Service;
	const sessions = yield* sql<{ readonly id: string; readonly threadId: string; readonly projectId: string }>`
		SELECT s.id, t.id AS thread_id, sp.project_id FROM session s
		JOIN thread t ON t.session_id = s.id JOIN space sp ON sp.id = s.space_id
		ORDER BY s.id
	`;
	// Each project leans on two or three models.
	const mixes = new Map<string, ReadonlyArray<readonly [Model, number]>>();
	const mixOf = (projectId: string) => {
		const known = mixes.get(projectId);
		if (known !== undefined) return known;
		const mix = Array.from({ length: int(2, 3) }, (_, rank) => [pickModel(), 6 - rank * 2] as const);
		mixes.set(projectId, mix);
		return mix;
	};
	const wrote = { sessions: 0, prompts: 0, requests: 0, aborted: 0, failed: 0, calls: 0 };

	for (const session of sessions) {
		const threadId = ThreadSchema.ID.make(session.threadId);
		const [head] = yield* sql<{ readonly seq: number }>`SELECT seq FROM sequence WHERE aggregate_id = ${session.id}`;
		let seq = head?.seq ?? 1;
		let day = startDay();
		const mix = mixOf(session.projectId);
		const model = weighted(mix);
		const thinking = weighted(THINKING);
		let context = int(8_000, 30_000);
		for (let turn = 0, turns = int(2, 14); turn < turns && day >= 0; turn++) {
			// Work hours, 08:00-20:00 UTC, so most zones see a working day.
			let at = UNTIL - day * DAY - (UNTIL % DAY) + int(8, 19) * 3_600_000 + int(0, 3_599_999);
			if (at > UNTIL) at = UNTIL - int(60_000, 3_600_000);
			const promptId = randomUUID();
			yield* threads.append({
				id: promptId,
				threadId,
				seq: ++seq,
				type: "user",
				data: JSON.stringify({ messageId: promptId, role: "user", time: { created: at } }),
				parts: [{ type: "text", data: JSON.stringify({ type: "text", text: pick(PROMPTS) }) }],
			});
			wrote.prompts++;
			const requests = int(1, 6);
			for (let step = 0; step < requests; step++) {
				const last = step === requests - 1;
				const fails = random() < 0.02;
				const interrupted = !fails && random() < 0.03;
				const input = fails ? int(200, 2_000) : int(300, 4_000);
				const cacheRead = fails ? 0 : Math.round(context * (0.55 + random() * 0.4));
				const cacheWrite = fails ? 0 : int(0, 3_000);
				const output = fails ? 0 : last ? int(150, 2_500) : int(40, 600);
				const reasoning = thinking === "off" || fails ? 0 : Math.round(output * random() * 0.6);
				const duration = skewed(1_200 + (output / model.speed) * 1_000);
				const [pIn, pOut, pRead, pWrite] = model.price.map((perMillion) => perMillion / 1_000_000) as [
					number,
					number,
					number,
					number,
				];
				const cost = {
					input: input * pIn,
					output: output * pOut,
					cacheRead: cacheRead * pRead,
					cacheWrite: cacheWrite * pWrite,
					total: input * pIn + output * pOut + cacheRead * pRead + cacheWrite * pWrite,
				};
				const calls =
					last || fails
						? []
						: Array.from(
								{
									length: weighted([
										[1, 6],
										[2, 3],
										[3, 1],
									] as const),
								},
								() => weighted(TOOLS),
							);
				const messageId = randomUUID();
				const envelope = {
					messageId,
					role: "assistant",
					protocol: model.provider,
					provider: { env: [], id: model.provider, name: model.name, source: "custom" },
					model: model.model,
					thinkingLevel: thinking,
					usage: {
						input,
						output,
						cacheRead,
						cacheWrite,
						reasoning,
						totalTokens: input + output + cacheRead + cacheWrite,
						cost,
					},
					stopReason: fails ? "error" : calls.length > 0 ? "toolUse" : interrupted ? "aborted" : "stop",
					time: { created: at, completed: at + duration },
					...(fails ? { errorMessage: "provider returned 529: overloaded" } : {}),
				};
				const parts = [
					...(output > 0
						? [{ type: "text" as const, data: JSON.stringify({ type: "text", text: "Working on it." }) }]
						: []),
					...calls.map((name, index) => {
						const callId = `call_${messageId}_${index}`;
						const status: ToolStatus = interrupted
							? "aborted"
							: random() < 0.06
								? "error"
								: random() < 0.02
									? "skipped"
									: "completed";
						return {
							type: "toolCall" as const,
							callId,
							toolName: name,
							status,
							data: JSON.stringify({
								type: "toolCall",
								callID: callId,
								name,
								arguments: {},
								status,
								time: { start: at + duration, end: at + duration + int(50, 4_000) },
								...(status === "completed" || status === "error"
									? { result: { content: [{ type: "text", text: "ok" }], isError: status === "error" } }
									: {}),
							}),
						};
					}),
				];
				const entry = { id: messageId, threadId, data: JSON.stringify(envelope), parts };
				if (interrupted) {
					yield* threads.append({ ...entry, seq: ++seq, type: "assistant", state: "draft" });
					yield* threads.abort({ ...entry, seq: ++seq });
					wrote.aborted++;
				} else yield* threads.append({ ...entry, seq: ++seq, type: "assistant" });
				wrote.requests++;
				if (fails) wrote.failed++;
				wrote.calls += parts.filter((part) => part.type === "toolCall").length;
				context += input + output;
				at += duration + int(500, 20_000);
				if (interrupted || fails) break;
			}
			// The next turn: the same day, or a later one.
			if (random() < 0.55) day -= int(1, 9);
		}
		// Live events of this session continue after the history.
		yield* sql`UPDATE sequence SET seq = ${seq} WHERE aggregate_id = ${session.id}`;
		wrote.sessions++;
	}
	return wrote;
});

const wrote = await Effect.runPromise(program.pipe(Effect.provide(layer)));
console.log(JSON.stringify(wrote));
