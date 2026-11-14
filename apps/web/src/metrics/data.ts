import { type MetricsHour, type MetricsRow, type MetricsUsage, readTopics } from "@codeworksh/contract";
import { Effect, Stream } from "effect";
import { Atom } from "effect/reactivity";

import { Server } from "../kernel/rpc";

/*
 * The Metrics page reads a year of usage once, at the server's grain (local day × session ×
 * provider × model × thinking level), and derives every period, card and colour from it here.
 */

export type RangeKey = "7d" | "30d" | "90d" | "1y";
export const RANGES: ReadonlyArray<{ readonly key: RangeKey; readonly label: string; readonly days: number }> = [
	{ key: "7d", label: "7 Days", days: 7 },
	{ key: "30d", label: "30 Days", days: 30 },
	{ key: "90d", label: "90 Days", days: 90 },
	{ key: "1y", label: "Year", days: 365 },
];
const YEAR = 365;
const daysOf = (range: RangeKey) => RANGES.find(({ key }) => key === range)?.days ?? 30;

// ---------------------------------------------------------------------------------------------
// Reads.

/** What the page is filtered to; null is every one. */
export interface Scope {
	readonly machineId: string | null;
	readonly projectId: string | null;
}

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (value: number) => String(value).padStart(2, "0");
/** A local day as the server takes it, `YYYY-MM-DD`. */
export const localDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** Local noon `ago` days before `day`: safe to format across a clock change. */
const noonOf = (day: string, ago: number) => {
	const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
	return new Date(year, month - 1, date - ago, 12).getTime();
};

const scoped = (scope: Scope) => ({
	...(scope.machineId === null ? {} : { machineId: scope.machineId }),
	...(scope.projectId === null ? {} : { projectId: scope.projectId }),
});

/** The year ending `today` for `scope`, as a `usageAtom` key. */
export const usageKey = (scope: Scope, today: string) =>
	JSON.stringify({ zone, since: localDay(new Date(noonOf(today, YEAR - 1))), until: today, ...scoped(scope) });

/** One day of `scope` by hour, as an `hoursAtom` key. */
export const hoursKey = (scope: Scope, day: string) => JSON.stringify({ zone, day, ...scoped(scope) });

interface Request {
	readonly zone: string;
	readonly machineId?: string;
	readonly projectId?: string;
}

/** `read` when subscribed, and again after each change to usage; a failure ends it until refreshed. */
const follow = <A, E>(read: Effect.Effect<A, E, Server>) =>
	Server.runtime.atom(
		Stream.unwrap(
			Server.use((client) => Effect.succeed(client("event.subscribe", { topics: readTopics.metrics }))),
		).pipe(
			// `Synced` first, once subscribed: the first read can miss no change.
			Stream.debounce("50 millis"),
			Stream.mapEffect(() => read),
		),
	);

export const usageAtom = Atom.family((key: string) => {
	const request = JSON.parse(key) as Request & { readonly since: string; readonly until: string };
	return follow(Server.use((client) => client("metrics.usage", request)));
});

export const hoursAtom = Atom.family((key: string) => {
	const request = JSON.parse(key) as Request & { readonly day: string };
	return follow(Server.use((client) => client("metrics.hours", request)));
});

// ---------------------------------------------------------------------------------------------
// The year, indexed.

/** Every sum a row carries, each one additive. */
const SUMMED = [
	"prompts",
	"steps",
	"input",
	"output",
	"reasoning",
	"cacheRead",
	"cacheWrite",
	"cost",
	"costInput",
	"costOutput",
	"costCacheRead",
	"costCacheWrite",
	"cacheSavings",
	/** Ms, every timed request's duration summed. */
	"modelTime",
	/** Requests with a duration: interrupted ones have none. */
	"timed",
	/** Output of rows with any timed request, for speed. */
	"timedOutput",
] as const;
type Sums = Record<(typeof SUMMED)[number], number>;

const zero = (): Sums => Object.fromEntries(SUMMED.map((field) => [field, 0])) as Sums;

/** Bucket counts summed, bucket by bucket. */
export const plus = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) =>
	Array.from({ length: Math.max(a.length, b.length) }, (_, at) => (a[at] ?? 0) + (b[at] ?? 0));

export interface Project {
	readonly id: string;
	readonly name: string;
}
export interface Session {
	readonly id: string;
	readonly title: string;
	readonly deleted: boolean;
	readonly project: Project;
}

/** A response row on its day. */
interface Item extends Sums {
	readonly ago: number;
	readonly machineId: string;
	readonly sessionId: string;
	readonly provider: string;
	readonly model: string;
	readonly thinking: string;
	readonly histogram: ReadonlyArray<number>;
}

/** Prompts, or one tool's calls, of a session on a day. */
interface Count {
	readonly ago: number;
	readonly machineId: string;
	readonly sessionId: string;
	readonly name: string;
	readonly count: number;
}

export interface Totals extends Sums {
	/** Sessions with any work in the period. */
	readonly sessions: number;
	/** Every token billed: input, output, cache read and cache write. */
	readonly tokens: number;
	readonly activeDays: number;
	/** Timed requests per duration bucket. */
	readonly histogram: ReadonlyArray<number>;
}

interface Spend {
	readonly tokens: number;
	readonly cost: number;
}

interface ModelSpend extends Spend {
	readonly provider: string;
	readonly model: string;
	readonly timed: number;
	readonly histogram: ReadonlyArray<number>;
}

interface SessionDay extends Spend {
	readonly session: Session;
	/** Threads worked that day. */
	readonly threads: number;
}

export interface Day extends Totals {
	readonly ago: number;
	/** `YYYY-MM-DD`. */
	readonly day: string;
	/** Local noon, for formatting. */
	readonly date: number;
	/** The sessions worked that day, so a longer span can count each session once. */
	readonly worked: ReadonlyArray<string>;
	/** Its sessions' spend, most tokens first. */
	readonly bySession: ReadonlyArray<SessionDay>;
	/** By `modelKey`. */
	readonly models: ReadonlyMap<string, ModelSpend>;
	readonly providers: ReadonlyMap<string, Spend>;
}

export interface Year {
	/** Upper bounds in ms of the duration buckets. */
	readonly edges: ReadonlyArray<number>;
	/** Oldest first, every day of the year, quiet ones included. */
	readonly days: ReadonlyArray<Day>;
	readonly items: ReadonlyArray<Item>;
	readonly prompts: ReadonlyArray<Count>;
	readonly tools: ReadonlyArray<Count>;
	readonly sessions: ReadonlyMap<string, Session>;
	readonly projects: ReadonlyArray<Project>;
	readonly machines: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

const UNKNOWN_PROJECT = "Unknown Project";
const tokensOf = (sums: Pick<Sums, "input" | "output" | "cacheRead" | "cacheWrite">) =>
	sums.input + sums.output + sums.cacheRead + sums.cacheWrite;
const modelKey = (provider: string, model: string) => `${provider}/${model}`;

/** What cache reads saved over paying the input price for them, by the row's own prices. */
const savingsOf = ({ tokens, cost }: MetricsRow) =>
	tokens.input > 0 && tokens.cacheRead > 0
		? tokens.cacheRead * (cost.input / tokens.input - cost.cacheRead / tokens.cacheRead)
		: 0;

const itemOf = (row: MetricsRow, ago: number): Item => ({
	ago,
	machineId: row.machineId,
	sessionId: row.sessionId,
	provider: row.provider,
	model: row.model,
	thinking: row.thinking,
	histogram: row.durations,
	prompts: 0,
	steps: row.requests,
	input: row.tokens.input,
	output: row.tokens.output,
	reasoning: row.tokens.reasoning,
	cacheRead: row.tokens.cacheRead,
	cacheWrite: row.tokens.cacheWrite,
	cost: row.cost.total,
	costInput: row.cost.input,
	costOutput: row.cost.output,
	costCacheRead: row.cost.cacheRead,
	costCacheWrite: row.cost.cacheWrite,
	cacheSavings: savingsOf(row),
	modelTime: row.duration,
	timed: row.timed,
	timedOutput: row.timed > 0 ? row.tokens.output : 0,
});

function groupBy<A, K>(items: ReadonlyArray<A>, key: (item: A) => K): Map<K, Array<A>> {
	const groups = new Map<K, Array<A>>();
	for (const item of items) {
		const group = groups.get(key(item));
		if (group === undefined) groups.set(key(item), [item]);
		else group.push(item);
	}
	return groups;
}

function total(items: ReadonlyArray<Item>, prompts: ReadonlyArray<Count>): Totals {
	const sum = zero();
	let histogram: ReadonlyArray<number> = [];
	for (const item of items) {
		for (const field of SUMMED) sum[field] += item[field];
		histogram = plus(histogram, item.histogram);
	}
	for (const prompt of prompts) sum.prompts += prompt.count;
	return {
		...sum,
		tokens: tokensOf(sum),
		sessions: new Set([...items, ...prompts].map((item) => item.sessionId)).size,
		activeDays: new Set(items.filter((item) => item.steps > 0).map((item) => item.ago)).size,
		histogram,
	};
}

const spendOf = (items: ReadonlyArray<Item>) => ({
	tokens: items.reduce((sum, item) => sum + tokensOf(item), 0),
	cost: items.reduce((sum, item) => sum + item.cost, 0),
});

/** The response for the year ending `today`, indexed by day; a row outside the year is left out. */
export function yearOf(usage: MetricsUsage, today: string): Year {
	const dates = Array.from({ length: YEAR }, (_, ago) => localDay(new Date(noonOf(today, ago))));
	const agoOf = new Map(dates.map((day, ago) => [day, ago]));
	const items = usage.rows.flatMap((row) => {
		const ago = agoOf.get(row.day);
		return ago === undefined ? [] : [itemOf(row, ago)];
	});
	const counts = (kind: "prompt" | "tool") =>
		usage.tallies.flatMap((tally) => {
			const ago = agoOf.get(tally.day);
			return tally.kind !== kind || ago === undefined
				? []
				: [{ ago, machineId: tally.machineId, sessionId: tally.sessionId, name: tally.name, count: tally.count }];
		});
	const prompts = counts("prompt");

	const projects = usage.projects.map((project) => ({ id: project.id, name: project.name ?? UNKNOWN_PROJECT }));
	const projectOf = new Map(projects.map((project) => [project.id, project]));
	const sessions = new Map(
		usage.sessions.map((session) => [
			session.id,
			{
				id: session.id,
				title: session.title ?? "",
				deleted: session.deleted,
				project: projectOf.get(session.projectId) ?? { id: session.projectId, name: UNKNOWN_PROJECT },
			},
		]),
	);
	const threads = new Map<string, number>();
	for (const row of usage.threads) {
		const key = `${row.day}\u0000${row.sessionId}`;
		threads.set(key, (threads.get(key) ?? 0) + row.threads);
	}

	const itemsByDay = groupBy(items, (item) => item.ago);
	const promptsByDay = groupBy(prompts, (prompt) => prompt.ago);
	const days = dates
		.map((day, ago): Day => {
			const dayItems = itemsByDay.get(ago) ?? [];
			const dayPrompts = promptsByDay.get(ago) ?? [];
			const totals = total(dayItems, dayPrompts);
			const models = new Map<string, ModelSpend>();
			for (const [key, group] of groupBy(dayItems, (item) => modelKey(item.provider, item.model))) {
				const { provider, model } = group[0] ?? { provider: "", model: "" };
				const { timed, histogram } = total(group, []);
				models.set(key, { ...spendOf(group), provider, model, timed, histogram });
			}
			const providers = new Map(
				[...groupBy(dayItems, (item) => item.provider)].map(([key, group]) => [key, spendOf(group)] as const),
			);
			const worked = [...new Set([...dayItems, ...dayPrompts].map((item) => item.sessionId))];
			const byItems = groupBy(dayItems, (item) => item.sessionId);
			return {
				...totals,
				ago,
				day,
				date: noonOf(today, ago),
				worked,
				bySession: worked
					.map((id) => ({
						...spendOf(byItems.get(id) ?? []),
						session: sessionOf(sessions, id),
						threads: threads.get(`${day}\u0000${id}`) ?? 0,
					}))
					.sort((a, b) => b.tokens - a.tokens),
				models,
				providers,
			};
		})
		.reverse();

	return {
		edges: usage.edges,
		days,
		items,
		prompts,
		tools: counts("tool"),
		sessions,
		projects,
		machines: usage.machines,
	};
}

/** A session the dictionary misses reads as deleted, so it folds away with them. */
const sessionOf = (sessions: ReadonlyMap<string, Session>, id: string): Session =>
	sessions.get(id) ?? { id, title: "", deleted: true, project: { id: "", name: UNKNOWN_PROJECT } };

// ---------------------------------------------------------------------------------------------
// A period.

type Dimension = "project" | "model" | "provider" | "thinking";

export interface SliceRow extends Totals {
	readonly key: string;
	readonly label: string;
	/** A second line: a model's provider. */
	readonly hint: string | undefined;
}

interface SessionRow extends Totals {
	readonly session: Session;
}

export interface Metrics {
	readonly range: RangeKey;
	/** Oldest first, every day of the period, quiet ones included. */
	readonly days: ReadonlyArray<Day>;
	readonly totals: Totals;
	/** The period before, for a change; the year has none. */
	readonly previous: Totals | undefined;
	/** Consecutive active days ending today or yesterday. */
	readonly streak: number;
	readonly bestStreak: number;
	readonly sessions: ReadonlyArray<SessionRow>;
	/** Most calls first. */
	readonly tools: ReadonlyArray<{ readonly name: string; readonly calls: number }>;
	readonly slice: (dimension: Dimension) => ReadonlyArray<SliceRow>;
	readonly edges: ReadonlyArray<number>;
}

/** Ordinal, least to most effort. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LABEL: Partial<Record<string, string>> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
	max: "Max",
};
/** A thinking level's place on the off → max scale. */
export const levelIndex = (key: string) => THINKING_LEVELS.findIndex((level) => level === key);

/** The metrics of a period of `year`. */
export function query(year: Year, range: RangeKey): Metrics {
	const span = daysOf(range);
	const within = <A extends { readonly ago: number }>(list: ReadonlyArray<A>, from: number, to: number) =>
		list.filter((item) => item.ago >= from && item.ago < to);
	const items = within(year.items, 0, span);
	const prompts = within(year.prompts, 0, span);
	const days = year.days.slice(YEAR - span);

	let streak = 0;
	for (let ago = (year.days.at(-1)?.steps ?? 0) > 0 ? 0 : 1; (year.days[YEAR - 1 - ago]?.steps ?? 0) > 0; ago++)
		streak++;
	let bestStreak = 0;
	let run = 0;
	for (const day of days) {
		run = day.steps > 0 ? run + 1 : 0;
		bestStreak = Math.max(bestStreak, run);
	}

	const promptsBySession = groupBy(prompts, (prompt) => prompt.sessionId);
	const itemsBySession = groupBy(items, (item) => item.sessionId);
	const sessions = [...new Set([...itemsBySession.keys(), ...promptsBySession.keys()])].map((id) => ({
		...total(itemsBySession.get(id) ?? [], promptsBySession.get(id) ?? []),
		session: sessionOf(year.sessions, id),
	}));

	const tools = new Map<string, number>();
	for (const tool of within(year.tools, 0, span)) tools.set(tool.name, (tools.get(tool.name) ?? 0) + tool.count);

	return {
		range,
		days,
		totals: total(items, prompts),
		previous:
			range === "1y" ? undefined : total(within(year.items, span, span * 2), within(year.prompts, span, span * 2)),
		streak,
		bestStreak,
		sessions,
		tools: [...tools].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls),
		slice: (dimension) => {
			const keyOf = (sessionId: string, item?: Item) => {
				if (dimension === "project") {
					const { project } = sessionOf(year.sessions, sessionId);
					return { key: project.id, label: project.name, hint: undefined };
				}
				if (item === undefined) return undefined;
				if (dimension === "model")
					return { key: modelKey(item.provider, item.model), label: item.model, hint: item.provider };
				if (dimension === "provider") return { key: item.provider, label: item.provider, hint: undefined };
				return { key: item.thinking, label: THINKING_LABEL[item.thinking] ?? item.thinking, hint: undefined };
			};
			const groups = new Map<
				string,
				{ label: string; hint: string | undefined; items: Array<Item>; prompts: Array<Count> }
			>();
			const into = (named: { key: string; label: string; hint: string | undefined }) => {
				const group = groups.get(named.key) ?? { label: named.label, hint: named.hint, items: [], prompts: [] };
				groups.set(named.key, group);
				return group;
			};
			for (const item of items) {
				const named = keyOf(item.sessionId, item);
				if (named !== undefined) into(named).items.push(item);
			}
			// Prompts belong to a session, not a request, so only the project slice counts them.
			if (dimension === "project")
				for (const prompt of prompts) {
					const named = keyOf(prompt.sessionId);
					if (named !== undefined) into(named).prompts.push(prompt);
				}
			const rows = [...groups]
				.map(([key, group]) => ({
					...total(group.items, group.prompts),
					key,
					label: group.label,
					hint: group.hint,
				}))
				// A model or provider whose requests all failed produced nothing; its requests still count by thinking level.
				.filter((row) => row.tokens > 0 || dimension === "project" || dimension === "thinking");
			return dimension === "thinking"
				? rows.sort((a, b) => levelIndex(a.key) - levelIndex(b.key))
				: rows.sort((a, b) => b.prompts - a.prompts);
		},
		edges: year.edges,
	};
}

/** Each session once, across the given days. */
export const sessionsIn = (days: ReadonlyArray<Day>): ReadonlyArray<string> => [
	...new Set(days.flatMap((day) => day.worked)),
];

/** A session list's line: a session, or every deleted one folded into one. */
export type Listed =
	| {
			readonly kind: "session";
			readonly key: string;
			readonly session: Session;
			readonly threads: number | undefined;
			readonly tokens: number;
			readonly cost: number;
	  }
	| {
			readonly kind: "deleted";
			readonly key: string;
			readonly count: number;
			readonly tokens: number;
			readonly cost: number;
	  };

/** Sessions most `by` first, the deleted ones summed into one line that sorts by its sum. */
export function listed(
	rows: ReadonlyArray<{
		readonly session: Session;
		readonly tokens: number;
		readonly cost: number;
		readonly threads?: number;
	}>,
	by: "tokens" | "cost",
): ReadonlyArray<Listed> {
	const deleted = rows.filter((row) => row.session.deleted);
	const lines: Array<Listed> = rows
		.filter((row) => !row.session.deleted)
		.map((row) => ({
			kind: "session",
			key: row.session.id,
			session: row.session,
			threads: row.threads,
			tokens: row.tokens,
			cost: row.cost,
		}));
	if (deleted.length > 0)
		lines.push({
			kind: "deleted",
			key: "deleted",
			count: deleted.length,
			tokens: deleted.reduce((sum, row) => sum + row.tokens, 0),
			cost: deleted.reduce((sum, row) => sum + row.cost, 0),
		});
	return lines.sort((a, b) => b[by] - a[by]);
}

interface ModelDay extends Spend {
	readonly key: string;
	readonly provider: string;
	readonly model: string;
	/** Its median request duration that day; none when no request was timed. */
	readonly median: Quantile | undefined;
	/** Tokens in each local hour, 0 to 23. */
	readonly hours: ReadonlyArray<number>;
}

/** A day's models, most tokens first, with their tokens by hour from that day's hourly read. */
export function modelsOn(day: Day, edges: ReadonlyArray<number>, hours: ReadonlyArray<MetricsHour>) {
	const byModel = groupBy(hours, (row) => modelKey(row.provider, row.model));
	return [...day.models]
		.filter(([, spend]) => spend.tokens > 0)
		.map(([key, spend]): ModelDay => {
			const perHour = Array.from({ length: 24 }, () => 0);
			for (const row of byModel.get(key) ?? []) perHour[row.hour] = (perHour[row.hour] ?? 0) + row.tokens;
			return {
				key,
				provider: spend.provider,
				model: spend.model,
				tokens: spend.tokens,
				cost: spend.cost,
				median: spend.timed === 0 ? undefined : quantile(spend.histogram, edges, 0.5),
				hours: perHour,
			};
		})
		.sort((a, b) => b.tokens - a.tokens);
}

export interface ProjectOption {
	readonly project: Project;
	readonly prompts: number;
	readonly sessions: number;
}

/** Every project's prompts and active sessions in a period, on one machine or all. */
export function projectOptions(year: Year, range: RangeKey, machineId: string | null): ReadonlyArray<ProjectOption> {
	const span = daysOf(range);
	const rows = new Map(year.projects.map((project) => [project.id, { prompts: 0, sessions: new Set<string>() }]));
	for (const item of [...year.items, ...year.prompts]) {
		if (item.ago >= span || (machineId !== null && item.machineId !== machineId)) continue;
		const row = rows.get(sessionOf(year.sessions, item.sessionId).project.id);
		if (row === undefined) continue;
		row.sessions.add(item.sessionId);
		if ("count" in item) row.prompts += item.count;
	}
	return year.projects.map((project) => {
		const row = rows.get(project.id);
		return { project, prompts: row?.prompts ?? 0, sessions: row?.sessions.size ?? 0 };
	});
}

// ---------------------------------------------------------------------------------------------
// Response time, from duration buckets.

/** A duration read from buckets; `open` when it fell in the last, unbounded one: at least `ms`. */
interface Quantile {
	readonly ms: number;
	readonly open: boolean;
}

/**
 * The `q` quantile of bucket counts, interpolated linearly inside its bucket. Bucket i spans
 * `edges[i - 1]` to `edges[i]`, the first from 0; the last is open-ended, so its lower edge stands in.
 */
export function quantile(histogram: ReadonlyArray<number>, edges: ReadonlyArray<number>, q: number) {
	const sum = histogram.reduce((all, count) => all + count, 0);
	if (sum === 0) return undefined;
	const target = q * sum;
	let seen = 0;
	for (const [at, count] of histogram.entries()) {
		if (count > 0 && seen + count >= target) {
			const low = at === 0 ? 0 : (edges[at - 1] ?? 0);
			const high = edges[at];
			if (high === undefined) return { ms: low, open: true } satisfies Quantile;
			return { ms: low + ((high - low) * (target - seen)) / count, open: false } satisfies Quantile;
		}
		seen += count;
	}
	return undefined;
}

export interface Response {
	readonly median: Quantile;
	readonly p95: Quantile;
	/** Output tokens per second of request time; none when no time was recorded. */
	readonly speed: number | undefined;
}

/** Response time over timed requests; durations are right-skewed, so median and p95, never a mean. */
export function responseOf(
	totals: Pick<Totals, "histogram" | "timed" | "modelTime" | "timedOutput">,
	edges: ReadonlyArray<number>,
): Response | undefined {
	if (totals.timed === 0) return undefined;
	const median = quantile(totals.histogram, edges, 0.5);
	const p95 = quantile(totals.histogram, edges, 0.95);
	if (median === undefined || p95 === undefined) return undefined;
	return {
		median,
		p95,
		speed: totals.modelTime > 0 ? totals.timedOutput / (totals.modelTime / 1000) : undefined,
	};
}

/** Names a model by its id, adding its provider when the id occurs under more than one provider in `rows`. */
export function modelNamer(rows: ReadonlyArray<{ readonly provider: string; readonly model: string }>) {
	const providers = new Map<string, Set<string>>();
	for (const row of rows) providers.set(row.model, (providers.get(row.model) ?? new Set()).add(row.provider));
	return (row: { readonly provider: string; readonly model: string }) =>
		(providers.get(row.model)?.size ?? 0) > 1 ? `${row.model} · ${row.provider}` : row.model;
}

/** A free or preview model reports tokens but no cost; "$0" would read as a bargain. */
export const unpriced = (spend: Spend) => spend.cost === 0 && spend.tokens > 0;

// ---------------------------------------------------------------------------------------------
// Formatting.

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const dollarsWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const dollarsSmall = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 0,
	maximumFractionDigits: 4,
});
const shortDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const longDay = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
});

export const formatCount = (value: number) => whole.format(value);
/** 48.3K, 1.2M, 2.4B. */
export const formatTokens = (value: number) => compact.format(value);
/** Whole dollars from a thousand, cents from a cent, up to four decimals below; "<$0.0001" rather than a rounded zero. */
export const formatCost = (value: number) =>
	value === 0
		? "$0"
		: value >= 1000
			? dollarsWhole.format(value)
			: value >= 0.01
				? dollars.format(value)
				: value >= 0.0001
					? dollarsSmall.format(value)
					: "<$0.0001";
/** A day by its local noon. */
export const formatDay = (date: number) => shortDay.format(date);
export const formatDayLong = (date: number) => longDay.format(date);
/** 850 ms, 4.6 s, 1m 12s, 30m, 2h 05m. */
export function formatDuration(ms: number) {
	if (ms === 0) return "0 s";
	if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`;
	const tenths = Math.round(ms / 100);
	if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60 === 0 ? "" : ` ${pad(seconds % 60)}s`}`;
	const minutes = Math.round(ms / 60_000);
	return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}
/** "4.6 s", or "≥ 30m" past the last bucket. */
export const formatQuantile = (value: Quantile) => `${value.open ? "≥ " : ""}${formatDuration(value.ms)}`;
/** 52 tok/s. */
export const formatSpeed = (perSecond: number) => `${Math.round(perSecond)} tok/s`;
export const formatPercent = (ratio: number) => `${Math.round(ratio * 100)}%`;
/** The change from `before` to `now` as a signed percent, or undefined when there is nothing to compare. */
export function change(now: number, before: number | undefined) {
	if (before === undefined || before === 0) return undefined;
	return (now - before) / before;
}
export const formatChange = (ratio: number) =>
	`${ratio >= 0 ? "+" : "−"}${Math.abs(ratio) >= 10 ? "999+" : Math.round(Math.abs(ratio) * 100)}%`;
/**
 * Share of input served from cache, or null with no input. A cache write counts as a miss: that
 * input was processed in full.
 */
export function cacheHit(totals: Pick<Totals, "input" | "cacheRead" | "cacheWrite">) {
	const all = totals.input + totals.cacheRead + totals.cacheWrite;
	return all === 0 ? null : totals.cacheRead / all;
}
