import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { ToolStatus } from "../db/schema.sql.ts";
import * as Store from "../db/store.ts";
import * as UsageSchema from "./schema.ts";

const HOUR = 3_600_000;
const hourOf = (time: number) => Math.floor(time / HOUR) * HOUR;

/** The histogram bucket of a duration in ms; see `UsageSchema.edges`. */
const bucketOf = (duration: number) => {
	const index = UsageSchema.edges.findIndex((edge) => duration < edge);
	return index === -1 ? UsageSchema.edges.length : index;
};

/** What the rollup reads of an entry. */
export interface Entry {
	readonly type: string;
	readonly state: string;
	readonly data: string;
}

export interface UsageDelta {
	readonly hour: number;
	readonly provider: string;
	readonly model: string;
	readonly thinking: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning: number;
	readonly cost: number;
	readonly costInput: number;
	readonly costOutput: number;
	readonly costCacheRead: number;
	readonly costCacheWrite: number;
	/** Absent unless the request committed with a usable duration. */
	readonly duration?: number;
}

export interface TallyDelta {
	readonly hour: number;
	readonly kind: UsageSchema.TallyKind;
	readonly name: string;
	readonly count: number;
}

/** A toolCall part of an entry. */
export interface Call {
	readonly name: string;
	readonly status: ToolStatus;
}

/** A call that ran and gave the model a result; skipped and aborted ones may never have started. */
const ran = (call: Call) => call.status === "completed" || call.status === "error";

/** The rows one finalised entry adds to; empty for any other entry. */
export interface Delta {
	readonly usage?: UsageDelta;
	readonly tallies: ReadonlyArray<TallyDelta>;
}

const decodeAssistant = Schema.decodeUnknownEffect(UsageSchema.Assistant);
const decodeUser = Schema.decodeUnknownEffect(UsageSchema.User);
const decodeDurations = Schema.decodeUnknownEffect(UsageSchema.Durations);
const encodeDurations = Schema.encodeEffect(UsageSchema.Durations);

/** Rejects an envelope the rollup could not read once its entry is finalised. */
export const validate = Effect.fn("Usage.validate")(function* (type: string, data: string) {
	if (type === "assistant") yield* decodeAssistant(data);
	if (type === "user") yield* decodeUser(data);
});

/**
 * The deltas of an entry with its toolCall parts. Only terminal assistant entries (committed or
 * aborted: an aborted request is billed too) and committed user entries count, so an entry counts
 * once, at the transition that finalises it. Only a committed request is timed: an aborted one's
 * `completed` is when it was interrupted, failed or healed after a crash, not when it answered.
 */
export const delta = Effect.fn("Usage.delta")(function* (entry: Entry, calls: ReadonlyArray<Call>) {
	const none: Delta = { tallies: [] };
	if (entry.type === "user" && entry.state === "committed") {
		const envelope = yield* decodeUser(entry.data);
		const prompt: Delta = { tallies: [{ hour: hourOf(envelope.time.created), kind: "prompt", name: "", count: 1 }] };
		return prompt;
	}
	if (entry.type !== "assistant" || (entry.state !== "committed" && entry.state !== "aborted")) {
		return none;
	}
	const { provider, model, thinkingLevel, usage, time } = yield* decodeAssistant(entry.data);
	const hour = hourOf(time.created);
	const elapsed = entry.state !== "committed" || time.completed === undefined ? -1 : time.completed - time.created;
	const counts = new Map<string, number>();
	for (const call of calls.filter(ran)) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
	const rolled: Delta = {
		usage: {
			hour,
			provider: provider.id,
			model,
			thinking: thinkingLevel,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			reasoning: usage.reasoning ?? 0,
			cost: usage.cost.total,
			costInput: usage.cost.input,
			costOutput: usage.cost.output,
			costCacheRead: usage.cost.cacheRead,
			costCacheWrite: usage.cost.cacheWrite,
			...(elapsed >= 0 ? { duration: elapsed } : {}),
		},
		tallies: [...counts].map(([name, count]): TallyDelta => ({ hour, kind: "tool", name, count })),
	};
	return rolled;
});

/** Adds `change` to the rows of `threadId`, stamped `rev`. */
const apply = Effect.fnUntraced(function* (threadId: string, rev: number, change: Delta) {
	const sql = yield* SqlClient.SqlClient;
	if (change.usage === undefined && change.tallies.length === 0) return;
	const [owner] = yield* sql<{ readonly sessionId: string; readonly projectId: string }>`
		SELECT t.session_id, sp.project_id FROM thread t
		JOIN session s ON s.id = t.session_id
		JOIN space sp ON sp.id = s.space_id
		WHERE t.id = ${threadId}
	`;
	if (owner === undefined) return yield* Effect.die(new Error(`usage: thread ${threadId} is gone`));
	const usage = change.usage;
	if (usage !== undefined) {
		const key = sql`hour = ${usage.hour} AND thread_id = ${threadId} AND provider = ${usage.provider}
			AND model = ${usage.model} AND thinking = ${usage.thinking}`;
		const [stored] = yield* sql<{ readonly durations: string }>`SELECT durations FROM usage WHERE ${key}`;
		const durations = [
			...(stored === undefined
				? Array.from({ length: UsageSchema.edges.length + 1 }, () => 0)
				: yield* decodeDurations(stored.durations)),
		];
		const timed = usage.duration === undefined ? 0 : 1;
		if (usage.duration !== undefined) durations[bucketOf(usage.duration)]! += 1;
		// Session and project are the row's first write's: a later relink never moves earlier usage.
		yield* sql`
			INSERT INTO usage (
				hour, thread_id, provider, model, thinking, session_id, project_id, requests, input, output,
				cache_read, cache_write, reasoning, cost, cost_input, cost_output, cost_cache_read, cost_cache_write,
				duration, timed, durations, rev
			) VALUES (
				${usage.hour}, ${threadId}, ${usage.provider}, ${usage.model}, ${usage.thinking}, ${owner.sessionId},
				${owner.projectId}, 1, ${usage.input}, ${usage.output}, ${usage.cacheRead}, ${usage.cacheWrite},
				${usage.reasoning}, ${usage.cost}, ${usage.costInput}, ${usage.costOutput}, ${usage.costCacheRead},
				${usage.costCacheWrite}, ${usage.duration ?? 0}, ${timed}, ${yield* encodeDurations(durations)}, ${rev}
			)
			ON CONFLICT (hour, thread_id, provider, model, thinking) DO UPDATE SET
				requests = requests + excluded.requests,
				input = input + excluded.input,
				output = output + excluded.output,
				cache_read = cache_read + excluded.cache_read,
				cache_write = cache_write + excluded.cache_write,
				reasoning = reasoning + excluded.reasoning,
				cost = cost + excluded.cost,
				cost_input = cost_input + excluded.cost_input,
				cost_output = cost_output + excluded.cost_output,
				cost_cache_read = cost_cache_read + excluded.cost_cache_read,
				cost_cache_write = cost_cache_write + excluded.cost_cache_write,
				duration = duration + excluded.duration,
				timed = timed + excluded.timed,
				durations = excluded.durations,
				rev = excluded.rev
		`;
	}
	for (const tally of change.tallies) {
		yield* sql`
			INSERT INTO tally (hour, thread_id, kind, name, session_id, project_id, count, rev)
			VALUES (${tally.hour}, ${threadId}, ${tally.kind}, ${tally.name}, ${owner.sessionId}, ${owner.projectId}, ${tally.count}, ${rev})
			ON CONFLICT (hour, thread_id, kind, name) DO UPDATE SET
				count = count + excluded.count,
				rev = excluded.rev
		`;
	}
});

/**
 * Rolls the stored entry `entryId` and its toolCall parts into the rows, stamped `rev`. Fails only when
 * its envelope does not decode.
 */
const rollup = Effect.fnUntraced(function* (entryId: string, rev: number) {
	const sql = yield* SqlClient.SqlClient;
	const [entry] = yield* sql<Entry & { readonly threadId: string }>`
			SELECT thread_id, type, state, data FROM entry WHERE id = ${entryId}
		`.pipe(Effect.orDie);
	if (entry === undefined) return yield* Effect.die(new Error(`usage: entry ${entryId} is gone`));
	const calls = yield* sql<Call>`
			SELECT tool_name AS name, status FROM part WHERE entry_id = ${entryId} AND type = 'toolCall' ORDER BY part_index
		`.pipe(Effect.orDie);
	const change = yield* delta(entry, calls);
	yield* apply(entry.threadId, rev, change).pipe(Effect.orDie);
});

/**
 * Rolls every finalised entry into the rows, the way the write path does, at one revision taken from
 * `rev` only when there is something to roll up. Expects the rows empty. An entry whose envelope does
 * not decode is skipped, so one bad historical row cannot keep the database from opening.
 */
export const backfill = Effect.fnUntraced(function* <R>(rev: Effect.Effect<number, never, R>) {
	const sql = yield* SqlClient.SqlClient;
	const entries = yield* sql<{ readonly id: string }>`
		SELECT id FROM entry
		WHERE (type = 'assistant' AND state IN ('committed', 'aborted')) OR (type = 'user' AND state = 'committed')
		ORDER BY seq, id
	`.pipe(Effect.orDie);
	if (entries.length === 0) return;
	const taken = yield* rev;
	let skipped = 0;
	for (const entry of entries) {
		yield* rollup(entry.id, taken).pipe(Effect.catchTag("SchemaError", () => Effect.sync(() => skipped++)));
	}
	if (skipped > 0)
		yield* Effect.logWarning(`usage backfill skipped ${skipped} entries whose envelope does not decode`);
});

export interface Interface {
	/**
	 * Rolls a stored entry into the rows inside the enclosing `Store.write`. The write validated its
	 * envelope (`validate`), so one that does not decode is a defect.
	 */
	readonly record: (entryId: string) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/usage/usage/Service") {}

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const store = yield* Store.Service;

		const record = Effect.fn("Usage.record")(function* (entryId: string) {
			yield* rollup(entryId, yield* store.rev).pipe(Effect.orDie, Effect.provideService(SqlClient.SqlClient, sql));
		});

		return Service.of({ record });
	}),
);
