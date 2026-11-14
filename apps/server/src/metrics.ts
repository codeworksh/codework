import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
	type MetricsHour,
	MetricsError,
	type MetricsRow,
	type MetricsSession,
	type MetricsTally,
	type MetricsUsage,
} from "@codeworksh/contract";
import { edges, UNTITLED } from "@codeworksh/widget/codework";
import { Reads } from "./reads.ts";

/*
 * The Metrics page's reads, from the mirrored usage rollup. SQL sums each UTC hour over threads and
 * stores; the hours are then bucketed into `zone`'s days and hours here, as SQLite knows no zones.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Past the widest UTC offsets (−12 and +14 hours): every UTC hour that can start on a requested local day. */
const MARGIN = 15 * HOUR;

interface Scope {
	readonly zone: string;
	readonly machineId?: string;
	readonly projectId?: string;
}

/** A day's UTC midnight; a malformed or impossible day (`2026-02-30`) is refused. */
const midnight = (day: string) => {
	const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	const at = parts === null ? Number.NaN : Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
	return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== day
		? Effect.fail(new MetricsError({ message: `"${day}" is not a day: expected YYYY-MM-DD.` }))
		: Effect.succeed(at);
};

/** Each UTC hour's local day and hour in `zone`; each hour is formatted once. */
const clock = (zone: string) =>
	Effect.try({
		try: () =>
			new Intl.DateTimeFormat("en-US", {
				timeZone: zone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				hourCycle: "h23",
			}),
		catch: () => new MetricsError({ message: `"${zone}" is not a time zone.` }),
	}).pipe(
		Effect.map((format) => {
			const seen = new Map<number, { readonly day: string; readonly hour: number }>();
			return (hour: number) => {
				const known = seen.get(hour);
				if (known !== undefined) return known;
				const part = Object.fromEntries(format.formatToParts(hour).map(({ type, value }) => [type, value]));
				const local = { day: `${part.year}-${part.month}-${part.day}`, hour: Number(part.hour) };
				seen.set(hour, local);
				return local;
			};
		}),
	);

/** The local days `since` to `until` in `zone`, and the UTC hours to read for them. */
const period = Effect.fn(function* (zone: string, since: string, until: string) {
	const local = yield* clock(zone);
	const from = yield* midnight(since);
	const to = yield* midnight(until);
	if (to < from)
		return yield* new MetricsError({ message: `The period ends (${until}) before it starts (${since}).` });
	return { local, from: from - MARGIN, to: to + DAY + MARGIN };
});

const where = (sql: SqlClient.SqlClient, scope: Scope, from: number, to: number) =>
	sql.and([
		sql`hour >= ${from}`,
		sql`hour < ${to}`,
		...(scope.machineId === undefined ? [] : [sql`machine_id = ${scope.machineId}`]),
		...(scope.projectId === undefined ? [] : [sql`project_id = ${scope.projectId}`]),
	]);

const decodeHistograms = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Array(Schema.Int))));

/** Each session's usage per UTC hour, provider, model and thinking level, summed over its threads and stores. */
const hourly = (sql: SqlClient.SqlClient, scope: Scope, from: number, to: number) =>
	sql<{
		machineId: string;
		hour: number;
		sessionId: string;
		provider: string;
		model: string;
		thinking: string;
		requests: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		reasoning: number;
		cost: number;
		costInput: number;
		costOutput: number;
		costCacheRead: number;
		costCacheWrite: number;
		duration: number;
		timed: number;
		durations: string;
	}>`
		SELECT machine_id, hour, session_id, provider, model, thinking, SUM(requests) AS requests,
			SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
			SUM(reasoning) AS reasoning, SUM(cost) AS cost, SUM(cost_input) AS cost_input, SUM(cost_output) AS cost_output,
			SUM(cost_cache_read) AS cost_cache_read, SUM(cost_cache_write) AS cost_cache_write,
			SUM(duration) AS duration, SUM(timed) AS timed, json_group_array(json(durations)) AS durations
		FROM usage WHERE ${where(sql, scope, from, to)}
		GROUP BY machine_id, hour, session_id, provider, model, thinking
	`;

/** Adds `value` into the entry at `key`, starting from `value` itself. */
const add = <A>(into: Map<string, A>, key: ReadonlyArray<string | number>, value: A, plus: (sum: A, value: A) => A) => {
	const id = key.join("\u0000");
	const sum = into.get(id);
	into.set(id, sum === undefined ? value : plus(sum, value));
};
/** Entries by key, so a read answers in the same order each time. */
const ordered = <A>(map: Map<string, A>) =>
	[...map].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value);

const plusRow = (sum: MetricsRow, row: MetricsRow): MetricsRow => ({
	...sum,
	requests: sum.requests + row.requests,
	tokens: {
		input: sum.tokens.input + row.tokens.input,
		output: sum.tokens.output + row.tokens.output,
		cacheRead: sum.tokens.cacheRead + row.tokens.cacheRead,
		cacheWrite: sum.tokens.cacheWrite + row.tokens.cacheWrite,
		reasoning: sum.tokens.reasoning + row.tokens.reasoning,
	},
	cost: {
		total: sum.cost.total + row.cost.total,
		input: sum.cost.input + row.cost.input,
		output: sum.cost.output + row.cost.output,
		cacheRead: sum.cost.cacheRead + row.cost.cacheRead,
		cacheWrite: sum.cost.cacheWrite + row.cost.cacheWrite,
	},
	duration: sum.duration + row.duration,
	timed: sum.timed + row.timed,
	durations: sum.durations.map((count, bucket) => count + (row.durations[bucket] ?? 0)),
});

export const usage = Effect.fn("Metrics.usage")(function* (
	request: Scope & { readonly since: string; readonly until: string },
) {
	const { local, from, to } = yield* period(request.zone, request.since, request.until);
	const inPeriod = (hour: number) => {
		const { day } = local(hour);
		return day >= request.since && day <= request.until ? day : undefined;
	};
	return yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const filter = where(sql, request, from, to);

		const rows = new Map<string, MetricsRow>();
		for (const row of yield* hourly(sql, request, from, to)) {
			const day = inPeriod(row.hour);
			if (day === undefined) continue;
			const empty = Array.from({ length: edges.length + 1 }, () => 0);
			const durations = (yield* decodeHistograms(row.durations)).reduce(
				(sum, list) => sum.map((count, bucket) => count + (list[bucket] ?? 0)),
				empty,
			);
			const key = [day, row.machineId, row.sessionId, row.provider, row.model, row.thinking];
			add(
				rows,
				key,
				{
					day,
					machineId: row.machineId,
					sessionId: row.sessionId,
					provider: row.provider,
					model: row.model,
					thinking: row.thinking,
					requests: row.requests,
					tokens: {
						input: row.input,
						output: row.output,
						cacheRead: row.cacheRead,
						cacheWrite: row.cacheWrite,
						reasoning: row.reasoning,
					},
					cost: {
						total: row.cost,
						input: row.costInput,
						output: row.costOutput,
						cacheRead: row.costCacheRead,
						cacheWrite: row.costCacheWrite,
					},
					duration: row.duration,
					timed: row.timed,
					durations,
				},
				plusRow,
			);
		}

		const tallies = new Map<string, MetricsTally>();
		const counted = yield* sql<{
			machineId: string;
			hour: number;
			sessionId: string;
			kind: MetricsTally["kind"];
			name: string;
			count: number;
		}>`
			SELECT machine_id, hour, session_id, kind, name, SUM(count) AS count FROM tally WHERE ${filter}
			GROUP BY machine_id, hour, session_id, kind, name
		`;
		for (const row of counted) {
			const day = inPeriod(row.hour);
			if (day === undefined) continue;
			const { machineId, sessionId, kind, name, count } = row;
			const tally = { day, machineId, sessionId, kind, name, count };
			add(tallies, [day, machineId, sessionId, kind, name], tally, (sum, next) => ({
				...sum,
				count: sum.count + next.count,
			}));
		}

		// Threads are summed away above, so the ones each session worked on a day are counted apart.
		const worked = yield* sql<{
			machineId: string;
			hour: number;
			sessionId: string;
			threadId: string;
			projectId: string;
		}>`
			SELECT machine_id, hour, session_id, thread_id, project_id FROM usage WHERE ${filter}
			UNION SELECT machine_id, hour, session_id, thread_id, project_id FROM tally WHERE ${filter}
		`;
		const threads = new Map<string, { day: string; machineId: string; sessionId: string; ids: Set<string> }>();
		const sessions = new Map<string, { id: string; machineId: string; projectId: string }>();
		for (const row of worked) {
			const day = inPeriod(row.hour);
			if (day === undefined) continue;
			const ids = new Set([row.threadId]);
			add(
				threads,
				[day, row.machineId, row.sessionId],
				{ day, machineId: row.machineId, sessionId: row.sessionId, ids },
				(sum, next) => {
					for (const id of next.ids) sum.ids.add(id);
					return sum;
				},
			);
			sessions.set(row.sessionId, { id: row.sessionId, machineId: row.machineId, projectId: row.projectId });
		}

		const ids = [...sessions.keys()];
		const projectIds = [...new Set([...sessions.values()].map((session) => session.projectId))];
		const machineIds = [...new Set([...sessions.values()].map((session) => session.machineId))];
		const named =
			ids.length === 0
				? []
				: yield* sql<{ id: string; deletedAt: number | null; title: string | null }>`
					SELECT session.id, session.deleted_at, thread.title FROM session
					LEFT JOIN thread ON thread.session_id = session.id AND thread.origin_kind = 'main'
					WHERE session.id IN ${sql.in(ids)}
				`;
		const titles = new Map(named.map((row) => [row.id, row]));
		const projects =
			projectIds.length === 0
				? []
				: yield* sql<{ id: string; name: string }>`
					SELECT id, name FROM project WHERE id IN ${sql.in(projectIds)} ORDER BY updated_at DESC, machine_id
				`;
		const projectNames = new Map<string, string>();
		for (const project of projects) if (!projectNames.has(project.id)) projectNames.set(project.id, project.name);
		const machines =
			machineIds.length === 0
				? []
				: yield* sql<Reads.MachineColumns & { id: string }>`
					SELECT machine.id, ${sql.literal(Reads.MACHINE)} FROM machine WHERE machine.id IN ${sql.in(machineIds)}
					ORDER BY machine.id
				`;

		return {
			rows: ordered(rows),
			tallies: ordered(tallies),
			threads: ordered(threads).map(({ ids, ...row }) => ({ ...row, threads: ids.size })),
			sessions: ordered(sessions).map((owner): MetricsSession => {
				const session = titles.get(owner.id);
				const deleted = session === undefined || session.deletedAt !== null;
				return { ...owner, title: deleted ? null : (session.title ?? UNTITLED), deleted };
			}),
			projects: projectIds.toSorted().map((id) => ({ id, name: projectNames.get(id) ?? null })),
			machines: machines.map((machine) => ({ id: machine.id, name: Reads.machineName(machine) })),
			edges: [...edges],
		} satisfies MetricsUsage;
	}).pipe(Effect.orDie);
});

export const hours = Effect.fn("Metrics.hours")(function* (request: Scope & { readonly day: string }) {
	const { local, from, to } = yield* period(request.zone, request.day, request.day);
	return yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const hours = new Map<string, MetricsHour>();
		for (const row of yield* hourly(sql, request, from, to)) {
			const { day, hour } = local(row.hour);
			if (day !== request.day) continue;
			// A clock change's repeated hour is one wall-clock hour: both of its UTC hours sum into it.
			add(
				hours,
				[String(hour).padStart(2, "0"), row.machineId, row.sessionId, row.provider, row.model],
				{
					hour,
					machineId: row.machineId,
					sessionId: row.sessionId,
					provider: row.provider,
					model: row.model,
					requests: row.requests,
					tokens: row.input + row.output + row.cacheRead + row.cacheWrite,
					cost: row.cost,
				},
				(sum, next) => ({
					...sum,
					requests: sum.requests + next.requests,
					tokens: sum.tokens + next.tokens,
					cost: sum.cost + next.cost,
				}),
			);
		}
		return ordered(hours);
	}).pipe(Effect.orDie);
});

export * as Metrics from "./metrics.ts";
