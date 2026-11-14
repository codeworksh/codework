import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { ProviderIcon } from "@/components/provider";
import { Card, Columns, Heat, heatCuts, HeatScale, Meter, OTHER, Segmented, Share, SINGLE, TipRows } from "./charts";
import {
	type Day,
	formatCost,
	formatCount,
	formatDay,
	formatDayLong,
	formatDuration,
	formatQuantile,
	formatTokens,
	hoursAtom,
	hoursKey,
	listed,
	type Metrics,
	modelNamer,
	modelsOn,
	RANGES,
	type Scope,
	sessionsIn,
	unpriced,
} from "./data";
import { SessionLine } from "./session";

const GAP = 2;
const MIN_CELL = 11;
const MAX_CELL = 16;
const LABEL_GAP = 8;
const BAR_HEIGHT = 20;
const WEEKS_FOLDED = 8;
/** Monday first: the working week reads as one run, the weekend at the end. */
const WEEKDAYS = [
	{ day: 1, label: "Mon" },
	{ day: 2, label: "Tue" },
	{ day: 3, label: "Wed" },
	{ day: 4, label: "Thu" },
	{ day: 5, label: "Fri" },
	{ day: 6, label: "Sat" },
	{ day: 0, label: "Sun" },
] as const;

const weekdayOf = (day: Day) => new Date(day.date).getDay();
const month = new Intl.DateTimeFormat(undefined, { month: "short" });
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** What the calendar counts, like a contribution graph's kinds. */
type Measure = "prompts" | "sessions" | "tokens" | "cost";
const MEASURE: Record<
	Measure,
	{ readonly label: string; readonly one: string; readonly many: string; readonly format: (value: number) => string }
> = {
	prompts: { label: "Prompts", one: "Prompt", many: "Prompts", format: formatCount },
	sessions: { label: "Sessions", one: "Session", many: "Sessions", format: formatCount },
	tokens: { label: "Tokens", one: "Token", many: "Tokens", format: formatTokens },
	cost: { label: "Cost", one: "Spent", many: "Spent", format: formatCost },
};
const KEYS = ["prompts", "sessions", "tokens", "cost"] as const;
/** The day view leads with spend. */
const HEADLINE: ReadonlyArray<Measure> = ["tokens", "cost", "sessions", "prompts"];
const MEASURES = KEYS.map((key) => ({ key, label: MEASURE[key].label }));
/** "1,204 Prompts", "$12.40 Spent". */
const amount = (measure: Measure, value: number) => {
	const { one, many, format } = MEASURE[measure];
	return `${format(value)} ${value === 1 ? one : many}`;
};

/** The year calendar with when-you-work beside it; a picked day opens its sessions below. */
export function Activity({
	year,
	scope,
	colors,
}: {
	readonly year: Metrics;
	readonly scope: Scope;
	/** The page's model colors by model key; a model missing here folds into Other. */
	readonly colors: ReadonlyMap<string, string>;
}) {
	const [picked, setPicked] = useState<number | undefined>(undefined);
	const [measure, setMeasure] = useState<Measure>("prompts");
	const pickedDay = picked === undefined ? undefined : year.days[year.days.length - 1 - picked];
	return (
		<Card
			title="Activity"
			action={
				<Segmented options={MEASURES} value={measure} onChange={setMeasure} label="Measure" className="ml-auto" />
			}
		>
			<div className="grid gap-6 @3xl:grid-cols-[minmax(0,1fr)_220px]">
				<div className="flex min-w-0 flex-col gap-4">
					<Calendar
						metrics={year}
						measure={measure}
						picked={picked}
						onPick={(ago) => setPicked((current) => (current === ago ? undefined : ago))}
					/>
					<Streaks year={year} measure={measure} />
				</div>
				<Weekdays year={year} measure={measure} />
			</div>
			{pickedDay !== undefined && (
				<DayDetail
					day={pickedDay}
					edges={year.edges}
					scope={scope}
					colors={colors}
					onClear={() => setPicked(undefined)}
				/>
			)}
		</Card>
	);
}

function Calendar({
	metrics,
	measure,
	picked,
	onPick,
}: {
	readonly metrics: Metrics;
	readonly measure: Measure;
	readonly picked: number | undefined;
	readonly onPick: (ago: number) => void;
}) {
	const { days } = metrics;
	const lead = days[0] === undefined ? 0 : weekdayOf(days[0]);
	const columns = Math.ceil((lead + days.length) / 7);
	const scroller = useRef<HTMLDivElement>(null);
	const labels = useRef<HTMLDivElement>(null);
	const [cell, setCell] = useState(MIN_CELL);
	// The cell grows with the card so the weeks fill the column; past the minimum it scrolls instead.
	useLayoutEffect(() => {
		const box = scroller.current;
		if (box === null) return;
		const fit = () => {
			const room = box.clientWidth - (labels.current?.offsetWidth ?? 0) - LABEL_GAP;
			setCell(Math.min(MAX_CELL, Math.max(MIN_CELL, Math.floor((room - (columns - 1) * GAP) / columns))));
		};
		const observer = new ResizeObserver(fit);
		observer.observe(box);
		return () => observer.disconnect();
	}, [columns]);
	// Open on the latest weeks when the calendar is wider than the card.
	useLayoutEffect(() => {
		const box = scroller.current;
		if (box !== null) box.scrollLeft = box.scrollWidth;
	}, [days, cell]);

	const width = columns * cell + (columns - 1) * GAP;
	const months = useMemo(() => {
		const starts = days.flatMap((entry, index) => {
			const date = new Date(entry.date);
			return index === 0 || date.getDate() === 1
				? [{ column: Math.floor((lead + index) / 7), label: month.format(date) }]
				: [];
		});
		// The period's opening month only gets a label when there is room before the next one.
		return starts.filter((start, index) => index !== 0 || (starts[1]?.column ?? columns) - start.column >= 3);
	}, [days, lead, columns]);
	const cuts = useMemo(() => heatCuts(days.map((entry) => entry[measure])), [days, measure]);
	const dayAt = (ago: number) => days[days.length - 1 - ago];
	const order = [measure, ...KEYS.filter((key) => key !== measure)];
	const { many, format } = MEASURE[measure];

	return (
		<section aria-label="Calendar" className="flex flex-col gap-2">
			<p className="text-ui text-ink-secondary">
				<span className="text-ink tabular-nums">{format(metrics.totals[measure])}</span> {many} in the Last 12
				Months
			</p>
			<div ref={scroller} className="overflow-x-auto pb-1">
				<div className="flex w-max" style={{ gap: LABEL_GAP }}>
					<div
						ref={labels}
						aria-hidden
						className="grid text-3xs text-ink-muted"
						style={{
							gridTemplateRows: `repeat(7, ${cell}px)`,
							rowGap: GAP,
							lineHeight: `${cell}px`,
							marginTop: 16,
						}}
					>
						{["", "Mon", "", "Wed", "", "Fri", ""].map((label, index) => (
							<span key={index}>{label}</span>
						))}
					</div>
					<div className="flex flex-col">
						<div aria-hidden className="relative h-4 text-3xs text-ink-muted" style={{ width }}>
							{months.map((start) => (
								<span
									key={start.column}
									className="absolute top-0"
									style={{ left: start.column * (cell + GAP) }}
								>
									{start.label}
								</span>
							))}
						</div>
						<Heat
							cell={cell}
							cuts={cuts}
							{...(picked === undefined ? {} : { picked })}
							onPick={onPick}
							days={days.map((entry) => ({
								ago: entry.ago,
								weekday: weekdayOf(entry),
								value: entry[measure],
							}))}
							title={({ ago }) => {
								const entry = dayAt(ago);
								return (
									<TipRows
										title={entry === undefined ? "" : formatDayLong(entry.date)}
										rows={
											entry === undefined || entry.steps === 0
												? []
												: order.map((key) => ({
														label: MEASURE[key].label,
														value: MEASURE[key].format(entry[key]),
													}))
										}
									/>
								);
							}}
						/>
					</div>
				</div>
			</div>
			<div className="flex justify-end">
				<HeatScale cuts={cuts} format={(value) => amount(measure, value)} />
			</div>
		</section>
	);
}

/** The measure's total per weekday over the year; the rows spread to the calendar column's height. */
function Weekdays({ year, measure }: { readonly year: Metrics; readonly measure: Measure }) {
	const weekdays = useMemo(() => {
		const sums = new Map<number, number>();
		for (const day of year.days) sums.set(weekdayOf(day), (sums.get(weekdayOf(day)) ?? 0) + day[measure]);
		return WEEKDAYS.map(({ day, label }) => ({ label, total: sums.get(day) ?? 0 }));
	}, [year.days, measure]);
	const max = Math.max(...weekdays.map((weekday) => weekday.total), 0);
	const { label, format } = MEASURE[measure];
	return (
		<div className="flex flex-col gap-1.5 @3xl:border-l @3xl:border-edge @3xl:pl-6">
			<h3 className="text-2xs text-ink-muted">By Weekday</h3>
			<ul className="flex flex-1 flex-col justify-between gap-1" aria-label={`${label} by Weekday`}>
				{weekdays.map((weekday) => (
					<li key={weekday.label} className="flex items-center gap-2 text-2xs">
						<span className={`w-7 shrink-0 ${max > 0 && weekday.total === max ? "text-ink" : "text-ink-muted"}`}>
							{weekday.label}
						</span>
						<Meter value={weekday.total} max={max} color={SINGLE} />
						<span className="w-12 shrink-0 text-right text-ink-secondary tabular-nums">
							{format(weekday.total)}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function Streaks({ year, measure }: { readonly year: Metrics; readonly measure: Measure }) {
	const busiest = year.days.reduce<Day | undefined>(
		(best, day) => (day[measure] > (best?.[measure] ?? 0) ? day : best),
		undefined,
	);
	return (
		<dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-edge pt-4 text-2xs @lg:grid-cols-4">
			<Stat label="Current Streak" value={days(year.streak)} />
			<Stat label="Best Streak" value={days(year.bestStreak)} />
			<Stat
				label="Active Days"
				value={`${formatCount(year.totals.activeDays)} of ${formatCount(year.days.length)}`}
			/>
			<Stat
				label="Busiest Day"
				value={busiest === undefined ? "–" : `${formatDay(busiest.date)} · ${amount(measure, busiest[measure])}`}
			/>
		</dl>
	);
}

const days = (count: number) => `${formatCount(count)} ${count === 1 ? "Day" : "Days"}`;

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<dt className="text-ink-muted">{label}</dt>
			<dd title={value} className="truncate text-ink tabular-nums">
				{value}
			</dd>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
const HOUR_TICKS = [0, 6, 12, 18, 23].map((at) => ({ at, label: HOURS[at] ?? "" }));
const MODEL_ROW =
	"grid grid-cols-[minmax(0,1fr)_48px_64px] items-center gap-x-3 @xs:grid-cols-[minmax(0,1fr)_48px_48px_64px]";

/** A picked day at a glance: headline numbers, tokens through the day by model, then its sessions. */
function DayDetail({
	day,
	edges,
	scope,
	colors,
	onClear,
}: {
	readonly day: Day;
	readonly edges: ReadonlyArray<number>;
	readonly scope: Scope;
	readonly colors: ReadonlyMap<string, string>;
	readonly onClear: () => void;
}) {
	// Until the day's hours arrive its chart stays empty; its totals are already here.
	const hours = Option.getOrElse(AsyncResult.value(useAtomValue(hoursAtom(hoursKey(scope, day.day)))), () => []);
	const spent = modelsOn(day, edges, hours);
	const name = modelNamer(spent);
	const models = spent.map((row) => ({ ...row, label: name(row), color: colors.get(row.key) ?? OTHER }));
	const sessions = listed(day.bySession, "tokens");
	const named = models.filter((row) => colors.has(row.key));
	const rest = models.filter((row) => !colors.has(row.key));
	const stacks = [
		...named.map((row) => ({ label: row.label, color: row.color, values: row.hours })),
		...(rest.length === 0
			? []
			: [
					{
						label: "Other",
						color: OTHER,
						values: HOURS.map((_, hour) => rest.reduce((sum, row) => sum + (row.hours[hour] ?? 0), 0)),
					},
				]),
	];
	const top = sessions[0]?.tokens ?? 0;
	return (
		<section aria-label={formatDayLong(day.date)} className="flex flex-col gap-4">
			<div className="flex min-h-7 items-center gap-4 border-b border-edge pb-1">
				<h2 className="mr-auto text-ui font-medium text-ink">{formatDayLong(day.date)}</h2>
				<button
					type="button"
					onClick={onClear}
					className="-mr-1.5 rounded-md px-1.5 py-0.5 text-2xs text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
				>
					Clear
				</button>
			</div>
			{day.bySession.length === 0 ? (
				<p className="py-6 text-center text-2xs text-ink-muted">No Work on This Day</p>
			) : (
				<>
					<dl className="grid grid-cols-2 gap-4 @md:grid-cols-3 @2xl:grid-cols-5">
						{[
							...HEADLINE.map((key) => ({ label: MEASURE[key].label, value: MEASURE[key].format(day[key]) })),
							{ label: "Model Time", value: formatDuration(day.modelTime) },
						].map((stat) => (
							<div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
								<dt className="text-2xs text-ink-muted">{stat.label}</dt>
								<dd className="truncate text-[18px] leading-6 font-semibold tracking-tight text-ink tabular-nums">
									{stat.value}
								</dd>
							</div>
						))}
					</dl>
					<div className="grid gap-6 @3xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
						<div className="flex min-w-0 flex-col gap-2">
							<h3 className="text-2xs text-ink-muted">Through the Day</h3>
							<Columns
								stacks={stacks}
								titles={HOURS.map((hour) => `${hour}:00`)}
								ticks={HOUR_TICKS}
								format={formatTokens}
								label="Tokens by model per hour"
								height={120}
							/>
						</div>
						<div className="flex min-w-0 flex-col gap-2">
							<h3 className="text-2xs text-ink-muted">Models Used</h3>
							<Share
								parts={models.map((row) => ({ label: row.label, value: row.tokens, color: row.color }))}
								format={formatTokens}
								label="Tokens by model"
							/>
							<ul className="@container text-ui">
								{models.map((row) => (
									<li key={row.key} className={`${MODEL_ROW} border-t border-edge/50 py-1.5 first:border-t-0`}>
										<span className="flex min-w-0 items-center gap-1.5">
											<span
												aria-hidden
												className="size-2 shrink-0 rounded-[2px]"
												style={{ backgroundColor: row.color }}
											/>
											<ProviderIcon id={row.provider} name={row.provider} className="size-3" />
											<span title={row.label} className="min-w-0 truncate text-ink">
												{row.label}
											</span>
										</span>
										<span
											title="Median Response"
											className="hidden text-right text-ink-muted tabular-nums @xs:block"
										>
											{row.median === undefined ? "–" : formatQuantile(row.median)}
										</span>
										<span className="text-right text-ink-secondary tabular-nums">
											{formatTokens(row.tokens)}
										</span>
										<span
											className={`text-right tabular-nums ${unpriced(row) ? "text-ink-muted" : "text-ink"}`}
										>
											{unpriced(row) ? "Unpriced" : formatCost(row.cost)}
										</span>
									</li>
								))}
							</ul>
						</div>
					</div>
					<div className="flex flex-col gap-1">
						<h3 className="flex gap-1.5 text-2xs text-ink-muted">
							Sessions <span className="tabular-nums">{formatCount(day.bySession.length)}</span>
						</h3>
						<ul className="@container">
							{sessions.map((line) => (
								<SessionLine key={line.key} line={line} by="tokens" max={top} />
							))}
						</ul>
					</div>
				</>
			)}
		</section>
	);
}

// ---------------------------------------------------------------------------------------------

interface Week {
	readonly slots: ReadonlyArray<Day | undefined>;
	readonly label: string;
	readonly sessions: number;
	readonly prompts: number;
	readonly tokens: number;
	readonly cost: number;
}

/** Calendar weeks, Sunday first like the heatmap, newest first. */
function weeksOf(days: ReadonlyArray<Day>): ReadonlyArray<Week> {
	const groups: Array<Array<Day | undefined>> = [];
	let current: Array<Day | undefined> | undefined;
	for (const day of days) {
		const weekday = weekdayOf(day);
		if (current === undefined || weekday === 0) {
			current = Array.from({ length: 7 }, () => undefined);
			groups.push(current);
		}
		current[weekday] = day;
	}
	return groups.reverse().map((slots) => {
		const present = slots.filter((slot): slot is Day => slot !== undefined);
		const first = present[0];
		const last = present.at(-1);
		const sum = (pick: (day: Day) => number) => present.reduce((total, day) => total + pick(day), 0);
		return {
			slots,
			label:
				first === undefined || last === undefined
					? ""
					: last.ago === 0
						? "This Week"
						: rangeLabel(first.date, last.date),
			sessions: sessionsIn(present).length,
			prompts: sum((day) => day.prompts),
			tokens: sum((day) => day.tokens),
			cost: sum((day) => day.cost),
		};
	});
}

/** "Nov 8 – 14", or "Oct 30 – Nov 5" across a month. */
function rangeLabel(first: number, last: number) {
	if (first === last) return monthDay.format(first);
	const start = new Date(first);
	const end = new Date(last);
	return start.getMonth() === end.getMonth()
		? `${monthDay.format(start)} – ${end.getDate()}`
		: `${monthDay.format(start)} – ${monthDay.format(end)}`;
}

const LEDGER = "grid grid-cols-[minmax(0,1fr)_84px_repeat(4,56px)] items-center gap-x-3";

/** The period week by week, folded to the latest weeks. */
export function Weeks({ metrics }: { readonly metrics: Metrics }) {
	const [all, setAll] = useState(false);
	const weeks = useMemo(() => weeksOf(metrics.days), [metrics.days]);
	const shown = all ? weeks : weeks.slice(0, WEEKS_FOLDED);
	// One scale for every row, so a tall bar means the same in any week.
	const max = Math.max(...metrics.days.map((day) => day.steps), 1);
	const label = RANGES.find(({ key }) => key === metrics.range)?.label ?? "";
	return (
		<Card title="Weeks" caption={metrics.range === "1y" ? "Past Year" : `Last ${label}`}>
			<div className="flex flex-col">
				<div className={`${LEDGER} h-7 border-b border-edge text-2xs text-ink-muted`}>
					<span>Week</span>
					<span>Requests</span>
					<span className="text-right">Sessions</span>
					<span className="text-right">Prompts</span>
					<span className="text-right">Tokens</span>
					<span className="text-right">Cost</span>
				</div>
				<ul>
					{shown.map((week) => (
						<li
							key={week.label}
							className={`${LEDGER} h-11 border-b border-edge/50 text-ui tabular-nums last:border-b-0`}
						>
							<span className="truncate text-ink">{week.label}</span>
							<span aria-hidden className="flex h-5 items-end gap-0.5">
								{week.slots.map((slot, index) => (
									<span key={index} className="flex h-full w-2.5 items-end">
										{slot === undefined ? null : slot.steps === 0 ? (
											<span className="h-px w-full bg-ink/15" />
										) : (
											<span
												className="w-full rounded-[1px]"
												style={{
													height: Math.max(2, (slot.steps / max) * BAR_HEIGHT),
													backgroundColor: SINGLE,
												}}
											/>
										)}
									</span>
								))}
							</span>
							<span className="text-right text-ink-secondary">{formatCount(week.sessions)}</span>
							<span className="text-right text-ink-secondary">{formatCount(week.prompts)}</span>
							<span className="text-right text-ink-secondary">{formatTokens(week.tokens)}</span>
							<span className="text-right text-ink">{formatCost(week.cost)}</span>
						</li>
					))}
				</ul>
				{shown.length < weeks.length && (
					<button
						type="button"
						onClick={() => setAll(true)}
						className="mt-2 self-start rounded-md px-1.5 py-1 text-2xs text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
					>
						Show All {weeks.length} Weeks
					</button>
				)}
			</div>
		</Card>
	);
}
