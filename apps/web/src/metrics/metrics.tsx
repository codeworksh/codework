import { ChartBarIcon, InfoIcon } from "@phosphor-icons/react";
import { type ReactNode, useMemo, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProviderIcon } from "@/components/provider";
import { Activity, Weeks } from "./activity";
import {
	Card,
	chunks,
	Columns,
	fold,
	ink,
	Legend,
	Lines,
	Meter,
	OTHER,
	palette,
	RAMP,
	Segmented,
	Share,
	Spark,
} from "./charts";
import {
	cacheHit,
	change,
	type Day,
	formatChange,
	formatCost,
	formatCount,
	formatDay,
	formatDuration,
	formatPercent,
	formatQuantile,
	formatSpeed,
	formatTokens,
	levelIndex,
	listed,
	type Metrics,
	modelNamer,
	plus,
	quantile,
	RANGES,
	responseOf,
	type Scope,
	sessionsIn,
	type SliceRow,
	type Totals,
	unpriced,
} from "./data";
import { SessionLine } from "./session";

/** The page below the header: the period's metrics, already scoped to the chosen machine and project. */
export function MetricsBody({
	year,
	metrics,
	scope,
	projectName,
	onProject,
}: {
	/** The whole year, for the calendar and the colours. */
	readonly year: Metrics;
	readonly metrics: Metrics;
	readonly scope: Scope;
	/** The project the page is scoped to, for an empty state to name. */
	readonly projectName: string | undefined;
	/** Scopes the page to a project, or back to all with null. */
	readonly onProject: (projectId: string | null) => void;
}) {
	// Colors follow the year's ranking, so a model keeps its color in every period and card.
	const modelColors = useMemo(() => palette(byTokens(year.slice("model")).map((row) => row.key)), [year]);
	const providerColors = useMemo(() => palette(byTokens(year.slice("provider")).map((row) => row.key)), [year]);
	const models = useMemo(
		() => fold(byTokens(metrics.slice("model")).map(partOf), modelColors, rest),
		[metrics, modelColors],
	);
	const providers = useMemo(
		() => fold(byTokens(metrics.slice("provider")).map(partOf), providerColors, rest),
		[metrics, providerColors],
	);
	// Where a label shows only the model id, an id under two providers also names its provider.
	const named = useMemo(() => {
		const name = modelNamer(models.parts.flatMap(modelOf).concat(models.rest.flatMap(modelOf)));
		return models.parts.map((part) => {
			const [model] = modelOf(part);
			return model === undefined ? part : { ...part, label: name(model) };
		});
	}, [models]);
	const period = RANGES.find(({ key }) => key === metrics.range)?.label.toLowerCase() ?? "";
	if (metrics.totals.steps === 0 && year.totals.steps === 0)
		return <Empty projectName={projectName} period={period} />;
	return (
		<div className="mx-auto flex max-w-[1100px] flex-col gap-4 px-6 py-6">
			<Stats metrics={metrics} period={period} />
			<Activity year={year} scope={scope} colors={modelColors} />
			<Work metrics={metrics} models={named} providers={providers.parts} />
			<div className="grid gap-4 @3xl:grid-cols-2">
				<Projects
					rows={metrics.slice("project")}
					projectId={scope.projectId}
					projectName={projectName}
					onProject={onProject}
				/>
				<Models parts={models.parts} rest={models.rest} edges={metrics.edges} />
			</div>
			<ResponseTime metrics={metrics} models={named} more={models.rest.length} />
			<Weeks metrics={metrics} />
			<Tools metrics={metrics} />
			<Thinking metrics={metrics} />
			<Cache metrics={metrics} />
			<TopSessions metrics={metrics} />
		</div>
	);
}

function Empty({ projectName, period }: { readonly projectName: string | undefined; readonly period: string }) {
	return (
		<div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
			<span className="grid size-9 place-items-center rounded-lg border border-edge text-ink-muted">
				<ChartBarIcon size={16} aria-hidden />
			</span>
			<div className="flex flex-col gap-1">
				<h2 className="text-ui font-medium text-ink">No Activity Yet</h2>
				<p className="max-w-80 text-2xs text-ink-muted">
					Nothing ran in <span className="text-ink-secondary">{projectName ?? "any project"}</span> over the last{" "}
					{period}.
				</p>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------

type Stat = "cost" | "tokens" | "sessions";

/** A year of daily points is too dense for a small chart; weeks read better. */
const buckets = (metrics: Metrics) => chunks(metrics.days, metrics.range === "1y" ? 7 : 1);

const sumOf = (days: ReadonlyArray<Day>, pick: (day: Day) => number) => days.reduce((sum, day) => sum + pick(day), 0);

/** Each session counted once per bucket. */
const trend = (metrics: Metrics, key: Stat) =>
	buckets(metrics).map((days) => (key === "sessions" ? sessionsIn(days).length : sumOf(days, (day) => day[key])));

const hitLabel = (totals: Pick<Totals, "input" | "cacheRead" | "cacheWrite">) => {
	const hit = cacheHit(totals);
	return hit === null ? "–" : formatPercent(hit);
};

/** A change badge in neutral ink, or nothing when there is nothing to compare. */
function Delta({ ratio, period }: { readonly ratio: number | undefined; readonly period: string }) {
	if (ratio === undefined) return null;
	return (
		<span title={`vs previous ${period}`} className="shrink-0 text-2xs text-ink-secondary tabular-nums">
			{ratio >= 0 ? "↑" : "↓"} {formatChange(ratio)}
		</span>
	);
}

function Stats({ metrics, period }: { readonly metrics: Metrics; readonly period: string }) {
	const { totals, previous } = metrics;
	const tiles: ReadonlyArray<{ key: Stat; label: string; value: string; hint: string | undefined }> = [
		{
			key: "cost",
			label: "Cost",
			value: formatCost(totals.cost),
			hint: totals.sessions === 0 ? undefined : `${formatCost(totals.cost / totals.sessions)} per Session`,
		},
		{
			key: "tokens",
			label: "Tokens",
			value: formatTokens(totals.tokens),
			hint: `${hitLabel(totals)} Cached`,
		},
		{
			key: "sessions",
			label: "Sessions",
			value: formatCount(totals.sessions),
			hint: `${formatCount(totals.prompts)} Prompts`,
		},
	];
	return (
		<div className="grid grid-cols-1 gap-4 @lg:grid-cols-3">
			{tiles.map((tile) => (
				<section key={tile.key} className="flex min-w-0 flex-col gap-1 rounded-lg border border-edge p-4">
					<h2 className="text-2xs text-ink-muted">{tile.label}</h2>
					<div className="flex items-baseline justify-between gap-2">
						<span className="truncate text-[22px] leading-7 font-semibold tracking-tight text-ink tabular-nums">
							{tile.value}
						</span>
						<Delta ratio={change(totals[tile.key], previous?.[tile.key])} period={period} />
					</div>
					<span className="h-4 truncate text-2xs text-ink-muted tabular-nums">{tile.hint}</span>
					<Spark values={trend(metrics, tile.key)} className="mt-2 h-8 w-full" />
				</section>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------

interface Part {
	readonly key: string;
	readonly label: string;
	readonly hint: string | undefined;
	readonly sessions: number;
	readonly prompts: number;
	readonly tokens: number;
	readonly cost: number;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
	readonly modelTime: number;
	readonly timed: number;
	readonly timedOutput: number;
	readonly histogram: ReadonlyArray<number>;
}
type Colored = Part & { readonly color: string };

const partOf = (row: SliceRow): Part => ({
	key: row.key,
	label: row.label,
	hint: row.hint,
	sessions: row.sessions,
	prompts: row.prompts,
	tokens: row.tokens,
	cost: row.cost,
	input: row.input,
	cacheRead: row.cacheRead,
	cacheWrite: row.cacheWrite,
	output: row.output,
	modelTime: row.modelTime,
	timed: row.timed,
	timedOutput: row.timedOutput,
	histogram: row.histogram,
});

const OTHER_KEY = "other";

/** A model slice row's provider and id: its hint and label; Other has none. */
const modelOf = (part: Part) =>
	part.key === OTHER_KEY || part.hint === undefined ? [] : [{ provider: part.hint, model: part.label }];

const byTokens = (rows: ReadonlyArray<SliceRow>) => rows.toSorted((a, b) => b.tokens - a.tokens);

function rest(rows: ReadonlyArray<Part>): Part {
	const sum = (pick: (row: Part) => number) => rows.reduce((total, row) => total + pick(row), 0);
	return {
		key: OTHER_KEY,
		label: "Other",
		hint: undefined,
		sessions: sum((row) => row.sessions),
		prompts: sum((row) => row.prompts),
		tokens: sum((row) => row.tokens),
		cost: sum((row) => row.cost),
		input: sum((row) => row.input),
		cacheRead: sum((row) => row.cacheRead),
		cacheWrite: sum((row) => row.cacheWrite),
		output: sum((row) => row.output),
		modelTime: sum((row) => row.modelTime),
		timed: sum((row) => row.timed),
		timedOutput: sum((row) => row.timedOutput),
		histogram: rows.reduce<ReadonlyArray<number>>((all, row) => plus(all, row.histogram), []),
	};
}

type Metric = "tokens" | "cost";
const METRICS: ReadonlyArray<{ readonly key: Metric; readonly label: string }> = [
	{ key: "tokens", label: "Tokens" },
	{ key: "cost", label: "Cost" },
];

/** Up to four evenly spread column indices: both ends and two between. */
const spread = (count: number) =>
	[...new Set([0, Math.round((count - 1) / 3), Math.round(((count - 1) * 2) / 3), count - 1])].filter((at) => at >= 0);

/** The period's columns, a day each or a week for the year, with their tooltip names and x ticks. */
function timeline(metrics: Metrics) {
	const weekly = metrics.range === "1y";
	const columns = buckets(metrics);
	const startOf = (at: number) => columns[at]?.[0]?.date ?? 0;
	return {
		weekly,
		columns,
		titles: columns.map((_, at) => (weekly ? `Week of ${formatDay(startOf(at))}` : formatDay(startOf(at)))),
		ticks: spread(columns.length).map((at) => ({ at, label: formatDay(startOf(at)) })),
	};
}

type View = "model" | "provider";
const VIEWS: ReadonlyArray<{ readonly key: View; readonly label: string }> = [
	{ key: "model", label: "Model" },
	{ key: "provider", label: "Provider" },
];

function Work({
	metrics,
	models,
	providers,
}: {
	readonly metrics: Metrics;
	readonly models: ReadonlyArray<Colored>;
	readonly providers: ReadonlyArray<Colored>;
}) {
	const [metric, setMetric] = useState<Metric>("tokens");
	const [view, setView] = useState<View>("model");
	const { weekly, columns, titles, ticks } = timeline(metrics);
	const parts = view === "model" ? models : providers;
	const named = parts.filter((part) => part.key !== OTHER_KEY);
	const valueOf = (days: ReadonlyArray<Day>, key: string) =>
		sumOf(days, (day) => (view === "model" ? day.models : day.providers).get(key)?.[metric] ?? 0);
	const stacks = parts.map((model) => ({
		label: model.label,
		color: model.color,
		...(metric === "cost" && unpriced(model) ? { format: () => "Unpriced" } : {}),
		values: columns.map((days) =>
			model.key === OTHER_KEY
				? Math.max(
						0,
						sumOf(days, (day) => day[metric]) - named.reduce((sum, head) => sum + valueOf(days, head.key), 0),
					)
				: valueOf(days, model.key),
		),
	}));
	const noun = metric === "tokens" ? "Tokens" : "Cost";
	return (
		<Card
			title="Work Over Time"
			caption={`${noun} by ${weekly ? "Week" : "Day"}`}
			action={
				<span className="flex shrink-0 items-center gap-2">
					<Segmented options={VIEWS} value={view} onChange={setView} label="Group By" />
					<Segmented options={METRICS} value={metric} onChange={setMetric} label="Metric" />
				</span>
			}
		>
			<Columns
				stacks={stacks}
				titles={titles}
				ticks={ticks}
				format={metric === "tokens" ? formatTokens : formatCost}
				label={`${noun} by ${view} ${weekly ? "per week" : "per day"}`}
				height={168}
			/>
			<Legend items={parts} />
		</Card>
	);
}

// ---------------------------------------------------------------------------------------------

interface Column {
	readonly label: string;
	readonly cell: (part: Colored) => ReactNode;
	/** Shown only when the card is wide enough. */
	readonly extra?: true;
}

function Breakdown({
	title,
	caption,
	head,
	noun,
	parts,
	rest,
	by,
	grid,
	columns,
	describe,
	provider = false,
	onPick,
}: {
	readonly title: string;
	readonly caption: string;
	/** The first column's heading. */
	readonly head: string;
	/** What a row is, plural: "Show All 12 Models". */
	readonly noun: string;
	readonly parts: ReadonlyArray<Colored>;
	/** The rows folded into Other, listed under it on demand. */
	readonly rest: ReadonlyArray<Part>;
	readonly by: "prompts" | "tokens";
	/** The row's grid template: the name, then one track per column. */
	readonly grid: string;
	readonly columns: ReadonlyArray<Column>;
	/** A row's tooltip, for what hidden columns would have said. */
	readonly describe?: (part: Colored) => string;
	/** The hint is a provider, so it wears the provider's mark. */
	readonly provider?: boolean;
	/** Makes each row, Other aside, a button. */
	readonly onPick?: (key: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const row = `grid ${grid} items-center gap-x-3`;
	const pressable = `${row} -mx-2 w-[calc(100%+16px)] rounded-md px-2 py-2 text-left outline-none hover:bg-ink/4 focus-visible:ring-2 focus-visible:ring-ring`;
	const hide = (column: Column) => (column.extra === true ? "hidden @sm:block" : "");
	const body = (part: Colored, hint: string | undefined) => (
		<>
			<span className="flex min-w-0 items-center gap-2">
				<span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: part.color }} />
				<span className="flex min-w-0 flex-col">
					<span className="truncate text-ink">{part.label}</span>
					{hint !== undefined && (
						<span className="flex min-w-0 items-center gap-1 text-2xs text-ink-muted">
							{provider && part.key !== OTHER_KEY && <ProviderIcon id={hint} name={hint} className="size-3" />}
							<span className="truncate">{hint}</span>
						</span>
					)}
				</span>
			</span>
			{columns.map((column) => (
				<span key={column.label} className={`text-right tabular-nums ${hide(column)}`}>
					{column.cell(part)}
				</span>
			))}
		</>
	);
	const item = (part: Colored) => (
		<li
			key={part.key}
			title={[part.label, part.hint, describe?.(part)].filter(Boolean).join(" · ")}
			className="border-t border-edge"
		>
			{onPick === undefined ? (
				<div className={`${row} py-2`}>{body(part, part.hint)}</div>
			) : (
				<button type="button" onClick={() => onPick(part.key)} className={pressable}>
					{body(part, part.hint)}
				</button>
			)}
		</li>
	);
	return (
		<Card title={title} caption={caption}>
			<Share
				parts={parts.map((part) => ({ label: part.label, value: part[by], color: part.color }))}
				format={by === "tokens" ? formatTokens : formatCount}
				label={`${title} by ${by}`}
			/>
			<div className="@container text-ui">
				<div className={`${row} pb-1 text-2xs text-ink-muted`}>
					<span>{head}</span>
					{columns.map((column) => (
						<span key={column.label} className={`text-right ${hide(column)}`}>
							{column.label}
						</span>
					))}
				</div>
				<ul>
					{parts.map((part) =>
						part.key !== OTHER_KEY ? (
							item(part)
						) : (
							<li key={part.key} className="border-t border-edge">
								<button
									type="button"
									aria-expanded={open}
									onClick={() => setOpen((current) => !current)}
									className={pressable}
								>
									{body(part, open ? "Show Fewer" : `Show All ${formatCount(rest.length)} ${noun}`)}
								</button>
								{open && (
									<ul className="-mx-2 max-h-80 overflow-y-auto px-2">
										{rest
											.toSorted((a, b) => b[by] - a[by])
											.map((folded) => item({ ...folded, color: OTHER }))}
									</ul>
								)}
							</li>
						),
					)}
				</ul>
			</div>
		</Card>
	);
}

const muted = (text: string) => <span className="text-ink-muted">{text}</span>;
const secondary = (text: string) => <span className="text-ink-secondary">{text}</span>;
const strong = (text: string) => <span className="text-ink">{text}</span>;

/** The project breakdown, each row scoping the page to its project. */
function Projects({
	rows,
	projectId,
	projectName,
	onProject,
}: {
	readonly rows: ReadonlyArray<SliceRow>;
	readonly projectId: string | null;
	readonly projectName: string | undefined;
	readonly onProject: (projectId: string | null) => void;
}) {
	if (projectId === null) {
		const { parts, rest: folded } = fold(rows.map(partOf), palette(rows.map((row) => row.key)), rest);
		return (
			<Breakdown
				title="Projects"
				caption="Share by Prompts"
				head="Project"
				noun="Projects"
				parts={parts}
				rest={folded}
				by="prompts"
				grid="grid-cols-[minmax(0,1fr)_56px_72px] @sm:grid-cols-[minmax(0,1fr)_56px_48px_72px]"
				columns={[
					{ label: "Sessions", cell: (part) => secondary(formatCount(part.sessions)) },
					{ label: "Tokens", cell: (part) => muted(formatTokens(part.tokens)), extra: true },
					{ label: "Cost", cell: (part) => strong(formatCost(part.cost)) },
				]}
				onPick={onProject}
			/>
		);
	}
	return (
		<Card title="Projects">
			<div className="flex items-center justify-between gap-3 text-ui">
				<span className="min-w-0 truncate text-ink-secondary">
					Showing <span className="text-ink">{projectName ?? rows[0]?.label ?? "Project"}</span>
				</span>
				<button
					type="button"
					onClick={() => onProject(null)}
					className="-mr-1.5 shrink-0 rounded-md px-1.5 py-0.5 text-2xs text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
				>
					All Projects
				</button>
			</div>
		</Card>
	);
}

const perMillion = (part: Part) =>
	part.tokens === 0 || unpriced(part) ? "–" : formatCost((part.cost / part.tokens) * 1_000_000);

function Models({
	parts,
	rest,
	edges,
}: {
	readonly parts: ReadonlyArray<Colored>;
	readonly rest: ReadonlyArray<Part>;
	readonly edges: ReadonlyArray<number>;
}) {
	return (
		<Breakdown
			title="Models"
			caption="Share by Tokens"
			head="Model"
			noun="Models"
			parts={parts}
			rest={rest}
			by="tokens"
			grid="grid-cols-[minmax(0,1fr)_48px_64px] @sm:grid-cols-[minmax(0,1fr)_48px_44px_52px_64px]"
			columns={[
				{ label: "Tokens", cell: (part) => secondary(formatTokens(part.tokens)) },
				{ label: "Cached", cell: (part) => muted(hitLabel(part)), extra: true },
				{ label: "$/M", cell: (part) => muted(perMillion(part)), extra: true },
				{
					label: "Cost",
					cell: (part) => (unpriced(part) ? muted("Unpriced") : strong(formatCost(part.cost))),
				},
			]}
			describe={(part) => {
				const response = responseOf(part, edges);
				const speed = response?.speed === undefined ? "" : ` · ${formatSpeed(response.speed)}`;
				const pace = response === undefined ? "" : ` · Median ${formatQuantile(response.median)}${speed}`;
				return `${hitLabel(part)} Cached · ${perMillion(part)}/M${pace}`;
			}}
			provider
		/>
	);
}

// ---------------------------------------------------------------------------------------------

const RESPONSE_ROW = "grid grid-cols-[minmax(0,1fr)_52px_52px_60px] items-center gap-x-3";

/**
 * Median request duration over time for the page's coloured models, beside a table that doubles as
 * the legend. Other gets no line: a median across unrelated models means nothing.
 */
function ResponseTime({
	metrics,
	models,
	more,
}: {
	readonly metrics: Metrics;
	readonly models: ReadonlyArray<Colored>;
	/** Models folded into Other. */
	readonly more: number;
}) {
	const { columns, titles, ticks } = timeline(metrics);
	const named = models.filter((model) => model.key !== OTHER_KEY);
	const overall = responseOf(metrics.totals, metrics.edges);
	return (
		<Card
			title="Response Time"
			caption="Median per Request"
			info={<Estimated />}
			action={
				overall !== undefined && (
					<span className="min-w-0 shrink truncate text-2xs text-ink-muted tabular-nums">
						Median <span className="text-ink-secondary">{formatQuantile(overall.median)}</span> · P95{" "}
						<span className="text-ink-secondary">{formatQuantile(overall.p95)}</span>
					</span>
				)
			}
		>
			{overall === undefined ? (
				<p className="py-4 text-center text-2xs text-ink-muted">No Requests</p>
			) : (
				<div className="grid gap-6 @3xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
					<Lines
						series={named.map((model) => ({
							label: model.label,
							color: model.color,
							values: columns.map((days) => {
								const spent = days.flatMap((day) => day.models.get(model.key) ?? []);
								// No timed request is a gap, never a zero.
								return spent.some((spend) => spend.timed > 0)
									? quantile(
											spent.reduce<ReadonlyArray<number>>((all, spend) => plus(all, spend.histogram), []),
											metrics.edges,
											0.5,
										)?.ms
									: undefined;
							}),
						}))}
						titles={titles}
						ticks={ticks}
						format={formatDuration}
						label="Median response time by model"
						height={168}
					/>
					<div className="min-w-0 text-ui">
						<div className={`${RESPONSE_ROW} pb-1 text-2xs text-ink-muted`}>
							<span>Model</span>
							<span className="text-right">Median</span>
							<span className="text-right">P95</span>
							<span className="text-right">Speed</span>
						</div>
						<ul>
							{named.map((model) => {
								const response = responseOf(model, metrics.edges);
								return (
									<li
										key={model.key}
										title={model.label}
										className={`${RESPONSE_ROW} border-t border-edge py-2`}
									>
										<Swatch color={model.color} label={model.label} />
										<span className="text-right text-ink tabular-nums">
											{response === undefined ? "–" : formatQuantile(response.median)}
										</span>
										<span className="text-right text-ink-secondary tabular-nums">
											{response === undefined ? "–" : formatQuantile(response.p95)}
										</span>
										<span className="text-right text-ink-muted tabular-nums">
											{response?.speed === undefined ? "–" : formatSpeed(response.speed)}
										</span>
									</li>
								);
							})}
							{more > 0 && (
								<li className="border-t border-edge py-2 text-2xs text-ink-muted">
									{formatCount(more)} More {more === 1 ? "Model" : "Models"}
								</li>
							)}
						</ul>
					</div>
				</div>
			)}
		</Card>
	);
}

/** What the response figures are estimated from, on click or Enter. */
function Estimated() {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label="About Response Time"
					className="relative grid size-4 shrink-0 place-items-center rounded-full text-ink-muted outline-none before:absolute before:-inset-1.5 before:content-[''] hover:text-ink focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] aria-expanded:text-ink"
				>
					<InfoIcon size={14} aria-hidden />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="flex w-64 flex-col gap-1 p-3 text-2xs">
				<span className="font-medium text-ink">Estimated From Duration Buckets</span>
				<p className="text-ink-secondary">
					Median and P95 are accurate to one duration bucket. Interrupted requests are not timed.
				</p>
			</PopoverContent>
		</Popover>
	);
}

// ---------------------------------------------------------------------------------------------

/** A swatch and a name: the first cell of a legend row. */
function Swatch({ color, label }: { readonly color: string; readonly label: string }) {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
			<span className="truncate text-ink">{label}</span>
		</span>
	);
}

const TOOLS_SHOWN = 12;
const TOOL_ROW = "grid grid-cols-[minmax(0,1fr)_64px_48px_36px] items-center gap-x-3";

/** Calls per tool, ranked down each column so the list fills the row. */
function Tools({ metrics }: { readonly metrics: Metrics }) {
	const { tools } = metrics;
	const callsOf = (list: ReadonlyArray<{ readonly calls: number }>) => list.reduce((all, tool) => all + tool.calls, 0);
	const sum = callsOf(tools);
	const shown = tools.slice(0, TOOLS_SHOWN);
	const hidden = tools.slice(TOOLS_SHOWN);
	const top = shown[0]?.calls ?? 0;
	const share = (calls: number) => (sum === 0 ? "–" : formatPercent(calls / sum));
	const item = `${TOOL_ROW} break-inside-avoid border-b border-edge/50 py-1.5`;
	return (
		<Card title="Tool Calls" caption={`${formatCount(sum)} Calls`}>
			{tools.length === 0 ? (
				<p className="py-4 text-center text-2xs text-ink-muted">No Tool Calls</p>
			) : (
				<ol className="columns-1 gap-x-8 text-ui @2xl:columns-2 @4xl:columns-3">
					{shown.map((tool) => (
						<li key={tool.name} className={item}>
							<span title={tool.name} className="truncate font-mono text-code text-ink">
								{tool.name}
							</span>
							<Meter value={tool.calls} max={top} />
							<span className="text-right text-ink tabular-nums">{formatCount(tool.calls)}</span>
							<span className="text-right text-ink-muted tabular-nums">{share(tool.calls)}</span>
						</li>
					))}
					{hidden.length > 0 && (
						<li className={item}>
							<span className="flex min-w-0 items-baseline gap-1.5">
								<span className="text-ink">Other</span>
								<span className="truncate text-2xs text-ink-muted">{formatCount(hidden.length)} more</span>
							</span>
							<span aria-hidden />
							<span className="text-right text-ink tabular-nums">{formatCount(callsOf(hidden))}</span>
							<span className="text-right text-ink-muted tabular-nums">{share(callsOf(hidden))}</span>
						</li>
					)}
				</ol>
			)}
		</Card>
	);
}

// ---------------------------------------------------------------------------------------------

const SESSION_ORDER: ReadonlyArray<{ readonly key: "cost" | "tokens"; readonly label: string }> = [
	{ key: "cost", label: "Cost" },
	{ key: "tokens", label: "Tokens" },
];

function TopSessions({ metrics }: { readonly metrics: Metrics }) {
	const [by, setBy] = useState<"cost" | "tokens">("cost");
	const top = listed(metrics.sessions, by).slice(0, 8);
	return (
		<Card
			title="Top Sessions"
			action={<Segmented options={SESSION_ORDER} value={by} onChange={setBy} label="Order By" className="ml-auto" />}
		>
			<ul className="@container -mt-2">
				{top.map((line) => (
					<SessionLine key={line.key} line={line} by={by} max={top[0]?.[by] ?? 0} />
				))}
			</ul>
		</Card>
	);
}

/** Requests by the reasoning effort asked for, on its ordered off → max scale. */
function Thinking({ metrics }: { readonly metrics: Metrics }) {
	const rows = metrics
		.slice("thinking")
		.filter((row) => row.steps > 0)
		.map((row) => ({ ...row, color: RAMP[levelIndex(row.key)] ?? OTHER }));
	const { steps, reasoning, output } = metrics.totals;
	return (
		<Card
			title="Thinking"
			caption="Requests · Share · Reasoning Tokens"
			action={
				<span className="min-w-0 shrink truncate text-2xs text-ink-muted tabular-nums">
					Reasoning <span className="text-ink-secondary">{formatTokens(reasoning)}</span>
					{output > 0 && ` · ${formatPercent(reasoning / output)} of Output`}
				</span>
			}
		>
			<Share
				parts={rows.map((row) => ({ label: row.label, value: row.steps, color: row.color }))}
				format={formatCount}
				label="Requests by thinking level"
			/>
			<ul className="grid grid-cols-2 gap-x-6 gap-y-4 @lg:grid-cols-4 @3xl:auto-cols-fr @3xl:grid-flow-col @3xl:grid-cols-none">
				{rows.map((row) => (
					<li key={row.key} className="flex min-w-0 flex-col gap-0.5">
						<span className="text-2xs">
							<Swatch color={row.color} label={row.label} />
						</span>
						<span className="text-ui text-ink tabular-nums">{formatCount(row.steps)}</span>
						<span className="truncate text-2xs text-ink-muted tabular-nums">
							{steps === 0 ? "–" : formatPercent(row.steps / steps)} · {formatTokens(row.reasoning)}
						</span>
					</li>
				))}
			</ul>
		</Card>
	);
}

/** Token types as ink tints, so they never read as one of the page's models. */
const TYPES = [
	{ key: "input", label: "Input", color: ink(60), tokens: "input", cost: "costInput" },
	{ key: "cacheRead", label: "Cache Read", color: ink(30), tokens: "cacheRead", cost: "costCacheRead" },
	{ key: "cacheWrite", label: "Cache Write", color: ink(72), tokens: "cacheWrite", cost: "costCacheWrite" },
	{ key: "output", label: "Output", color: ink(100), tokens: "output", cost: "costOutput" },
] as const;

const CACHE_ROW = "grid grid-cols-[minmax(0,1fr)_56px_64px] items-center gap-x-3";

/** Hit rate per bucket; a bucket with no input repeats the last known rate so the line has no holes. */
function hitTrend(metrics: Metrics) {
	const rates = buckets(metrics).map((days) =>
		cacheHit({
			input: sumOf(days, (day) => day.input),
			cacheRead: sumOf(days, (day) => day.cacheRead),
			cacheWrite: sumOf(days, (day) => day.cacheWrite),
		}),
	);
	let last = rates.find((rate) => rate !== null) ?? 0;
	return rates.map((rate) => {
		if (rate !== null) last = rate;
		return last;
	});
}

function Cache({ metrics }: { readonly metrics: Metrics }) {
	const { totals, previous } = metrics;
	const hit = cacheHit(totals);
	const before = previous === undefined ? undefined : (cacheHit(previous) ?? undefined);
	const period = RANGES.find(({ key }) => key === metrics.range)?.label.toLowerCase() ?? "";
	return (
		<Card title="Cache">
			<div className="grid gap-6 @3xl:grid-cols-[200px_minmax(0,1fr)_minmax(0,1fr)]">
				<div className="flex flex-col gap-1">
					<span className="text-2xs text-ink-muted">Cache Hit Rate</span>
					<div className="flex items-baseline justify-between gap-2">
						<span className="text-[22px] leading-7 font-semibold tracking-tight text-ink tabular-nums">
							{hit === null ? "–" : formatPercent(hit)}
						</span>
						<Delta ratio={hit === null ? undefined : change(hit, before)} period={period} />
					</div>
					<Spark values={hitTrend(metrics)} className="mt-2 h-8 w-full" />
					<dl className="mt-3 flex flex-col gap-0.5 text-2xs">
						<dt className="text-ink-muted">Saved by Cache</dt>
						<dd className="text-ink tabular-nums">{formatCost(totals.cacheSavings)}</dd>
					</dl>
				</div>
				<div className="flex flex-col gap-2">
					<span className="text-2xs text-ink-muted">Tokens by Type</span>
					<Share
						parts={TYPES.map((type) => ({ label: type.label, value: totals[type.tokens], color: type.color }))}
						format={formatTokens}
						label="Tokens by type"
					/>
					<span className="pt-2 text-2xs text-ink-muted">Cost by Type</span>
					<Share
						parts={TYPES.map((type) => ({ label: type.label, value: totals[type.cost], color: type.color }))}
						format={formatCost}
						label="Cost by type"
					/>
				</div>
				<div className="text-ui">
					<div className={`${CACHE_ROW} pb-1 text-2xs text-ink-muted`}>
						<span>Type</span>
						<span className="text-right">Tokens</span>
						<span className="text-right">Cost</span>
					</div>
					<ul>
						{TYPES.map((type) => (
							<li key={type.key} className={`${CACHE_ROW} border-t border-edge py-2`}>
								<Swatch color={type.color} label={type.label} />
								<span className="text-right text-ink-secondary tabular-nums">
									{formatTokens(totals[type.tokens])}
								</span>
								<span className="text-right text-ink tabular-nums">{formatCost(totals[type.cost])}</span>
							</li>
						))}
					</ul>
				</div>
			</div>
		</Card>
	);
}
