import { type MouseEvent, type ReactNode, type Ref, useCallback, useLayoutEffect, useRef, useState } from "react";

/* Chart pieces and the card they sit in. Marks carry color; text stays in ink tokens. */

/** Categorical slots, assigned in this order and never cycled; what is past the last folds into Other. */
const SERIES = [
	"light-dark(#2a78d6, #3987e5)",
	"light-dark(#eb6834, #d95926)",
	"light-dark(#1baf7a, #199e70)",
	"light-dark(#eda100, #c98500)",
	"light-dark(#e87ba4, #d55181)",
] as const;
export const OTHER = "light-dark(#b4b3ad, #5c5b56)";
/** One hue for a lone series: magnitude, not identity. */
export const SINGLE = SERIES[0];
/** Neutral ink at `percent` over the surface: for parts of one thing, never confused with a series. */
export const ink = (percent: number) => `color-mix(in oklab, var(--cw-ink) ${percent}%, var(--cw-frame))`;
/** An ordered scale in one hue, least to most; the first step is "none" and stays neutral. */
export const RAMP = [
	"light-dark(#d9d8d3, #3a3936)",
	"light-dark(#cfe1f9, #16406f)",
	"light-dark(#a3c6f2, #184f95)",
	"light-dark(#6da7ec, #1c5cab)",
	"light-dark(#2a78d6, #3987e5)",
	"light-dark(#1a5bb0, #6ea8ee)",
	"light-dark(#104281, #9ec5f4)",
] as const;
/** Quiet to busy, one hue; the first step is an empty day. */
const HEAT = [
	"color-mix(in oklab, var(--cw-ink) 7%, transparent)",
	"light-dark(#b7d3f6, #184f95)",
	"light-dark(#6da7ec, #1c5cab)",
	"light-dark(#2a78d6, #3987e5)",
	"light-dark(#104281, #9ec5f4)",
] as const;

/** A color for each of the first `SERIES.length` keys, in order; the rest get none and fold into Other. */
export const palette = (keys: ReadonlyArray<string>): ReadonlyMap<string, string> =>
	new Map(SERIES.flatMap((color, index) => (keys[index] === undefined ? [] : [[keys[index], color] as const])));

/** Rows with a color keep it, in order; the rest are summed into one trailing Other row and also returned as `rest`. */
export function fold<Row extends { readonly key: string }>(
	rows: ReadonlyArray<Row>,
	colors: ReadonlyMap<string, string>,
	sum: (rest: ReadonlyArray<Row>) => Row,
): { readonly parts: ReadonlyArray<Row & { readonly color: string }>; readonly rest: ReadonlyArray<Row> } {
	const head = rows.flatMap((row) => {
		const color = colors.get(row.key);
		return color === undefined ? [] : [{ ...row, color }];
	});
	const rest = rows.filter((row) => !colors.has(row.key));
	return { parts: rest.length === 0 ? head : [...head, { ...sum(rest), color: OTHER }], rest };
}

/** Consecutive runs of `size`, the last run short when the items do not divide evenly. */
export function chunks<A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> {
	const runs: Array<ReadonlyArray<A>> = [];
	for (let start = 0; start < items.length; start += size) runs.push(items.slice(start, start + size));
	return runs;
}

/**
 * A round number at or above `max` whose half is also round, so both ticks read clean: whole from 1
 * up, and decimal below it, where only a fraction like a cost can land.
 */
function niceMax(max: number) {
	if (max === 0 || (max >= 1 && max <= 2)) return 2;
	const half = max / 2;
	const magnitude = 10 ** Math.floor(Math.log10(half));
	const step =
		[1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(
			(candidate) => candidate * magnitude >= half && (max < 1 || Number.isInteger(candidate * magnitude)),
		) ?? 10;
	return 2 * step * magnitude;
}

export function Card({
	title,
	caption,
	info,
	action,
	className = "",
	children,
}: {
	readonly title: string;
	readonly caption?: string;
	/** A note on how to read the card, after the caption. */
	readonly info?: ReactNode;
	/** A control at the header's end. */
	readonly action?: ReactNode;
	readonly className?: string;
	readonly children: ReactNode;
}) {
	return (
		<section className={`flex min-w-0 flex-col gap-4 rounded-lg border border-edge p-4 ${className}`}>
			<header className="flex min-h-5 min-w-0 items-center gap-2">
				<h2 className="shrink-0 text-ui font-medium text-ink">{title}</h2>
				{caption !== undefined && (
					<span className={`truncate text-2xs text-ink-muted ${info === undefined ? "mr-auto" : ""}`}>
						{caption}
					</span>
				)}
				{info !== undefined && <span className="mr-auto flex shrink-0">{info}</span>}
				{action}
			</header>
			{children}
		</section>
	);
}

/** A few mutually exclusive options in a row. */
export function Segmented<Key extends string>({
	options,
	value,
	onChange,
	label,
	className = "",
}: {
	readonly options: ReadonlyArray<{ readonly key: Key; readonly label: string }>;
	readonly value: Key;
	readonly onChange: (key: Key) => void;
	readonly label: string;
	readonly className?: string;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className={`flex h-7 shrink-0 items-center rounded-md border border-edge p-0.5 ${className}`}
		>
			{options.map((option) => (
				<button
					key={option.key}
					type="button"
					role="radio"
					aria-checked={value === option.key}
					onClick={() => onChange(option.key)}
					className="h-full rounded-[4px] px-2 text-xs font-medium text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] aria-checked:bg-selection-strong aria-checked:text-ink"
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// Hover tooltip: one floating card that follows the pointer.

interface Tip {
	readonly x: number;
	readonly y: number;
	readonly content: ReactNode;
}

function useTip() {
	const [tip, setTip] = useState<Tip | null>(null);
	const show = useCallback(
		(event: MouseEvent, content: ReactNode) => setTip({ x: event.clientX, y: event.clientY, content }),
		[],
	);
	const hide = useCallback(() => setTip(null), []);
	const flip = tip !== null && tip.x > window.innerWidth - 260;
	const element =
		tip === null ? null : (
			<div
				role="tooltip"
				className="pointer-events-none fixed z-50 max-w-60 rounded-lg border border-edge bg-popover px-2.5 py-2 text-2xs text-ink shadow-[var(--cw-menu-shadow)]"
				style={{
					left: tip.x,
					top: tip.y,
					transform: `translate(${flip ? "calc(-100% - 12px)" : "12px"}, 12px)`,
				}}
			>
				{tip.content}
			</div>
		);
	return { show, hide, element };
}

/** A tooltip's body: a title, then one row per value with its swatch. */
export function TipRows({
	title,
	rows,
}: {
	readonly title: string;
	readonly rows: ReadonlyArray<{ readonly label: string; readonly value: string; readonly color?: string }>;
}) {
	return (
		<div className="flex flex-col gap-1">
			<span className="font-medium text-ink">{title}</span>
			{rows.map((row) => (
				<span key={row.label} className="flex items-center gap-1.5 text-ink-secondary">
					{row.color !== undefined && (
						<span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: row.color }} />
					)}
					<span className="min-w-0 flex-1 truncate">{row.label}</span>
					<span className="pl-3 text-ink tabular-nums">{row.value}</span>
				</span>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------

interface Stack {
	readonly label: string;
	readonly color: string;
	/** One value per column, oldest first. */
	readonly values: ReadonlyArray<number>;
	/** This stack's tooltip value, when the chart's `format` does not fit it. */
	readonly format?: (value: number) => string;
}

/**
 * Stacked columns over time on one axis. Columns cap at 24px and leave the rest of their slot as
 * air; segments are parted by a 2px gap of the surface.
 */
export function Columns({
	stacks,
	titles,
	ticks,
	format,
	label,
	height = 160,
}: {
	readonly stacks: ReadonlyArray<Stack>;
	/** A column's name in its tooltip. */
	readonly titles: ReadonlyArray<string>;
	/** The few x labels worth showing, by column index. */
	readonly ticks: ReadonlyArray<{ readonly at: number; readonly label: string }>;
	readonly format: (value: number) => string;
	/** What the chart shows, for a screen reader. */
	readonly label: string;
	readonly height?: number;
}) {
	const tip = useTip();
	const count = titles.length;
	const sums = titles.map((_, index) => stacks.reduce((sum, stack) => sum + (stack.values[index] ?? 0), 0));
	const top = niceMax(Math.max(...sums, 0));
	return (
		<Plot
			label={label}
			top={top}
			format={format}
			height={height}
			ticks={ticks}
			count={count}
			onMouseLeave={tip.hide}
			tooltip={tip.element}
		>
			<div className="absolute inset-0 flex items-end">
				{sums.map((sum, index) => (
					<div
						key={titles[index]}
						className="group/column flex h-full min-w-0 flex-1 items-end justify-center hover:bg-ink/4"
						onMouseMove={(event) =>
							tip.show(
								event,
								<TipRows
									title={titles[index] ?? ""}
									rows={
										stacks.length === 1
											? [{ label: stacks[0]?.label ?? "", value: format(sum) }]
											: [
													...stacks.map((stack) => ({
														label: stack.label,
														value: (stack.format ?? format)(stack.values[index] ?? 0),
														color: stack.color,
													})),
													{ label: "Total", value: format(sum) },
												]
									}
								/>,
							)
						}
					>
						<div
							className="flex w-full max-w-6 flex-col-reverse gap-0.5 overflow-hidden rounded-t-[4px]"
							style={{ height: `${(sum / top) * 100}%`, marginInline: count > 120 ? 0 : "12%" }}
						>
							{stacks.map((stack) =>
								(stack.values[index] ?? 0) === 0 ? null : (
									<span
										key={stack.label}
										className="min-h-px w-full"
										style={{
											// Grow factors summing below 1 leave the column part empty.
											flexGrow: ((stack.values[index] ?? 0) / sum) * 100,
											flexBasis: 0,
											backgroundColor: stack.color,
										}}
									/>
								),
							)}
						</div>
					</div>
				))}
			</div>
		</Plot>
	);
}

/** The frame a time chart sits in: y labels at zero, half and top, a hairline grid, x ticks below. */
function Plot({
	label,
	top,
	format,
	height,
	ticks,
	count,
	area,
	onMouseMove,
	onMouseLeave,
	tooltip,
	children,
}: {
	readonly label: string;
	readonly top: number;
	readonly format: (value: number) => string;
	readonly height: number;
	readonly ticks: ReadonlyArray<{ readonly at: number; readonly label: string }>;
	/** Columns the x axis is split into; a tick sits at its column's centre. */
	readonly count: number;
	readonly area?: Ref<HTMLDivElement>;
	readonly onMouseMove?: (event: MouseEvent<HTMLDivElement>) => void;
	readonly onMouseLeave: () => void;
	readonly tooltip: ReactNode;
	readonly children: ReactNode;
}) {
	return (
		<div role="img" aria-label={label} className="flex flex-col gap-1.5">
			<div className="flex gap-2">
				<div
					aria-hidden
					className="flex w-9 shrink-0 flex-col justify-between text-right text-3xs whitespace-nowrap text-ink-muted tabular-nums"
					style={{ height }}
				>
					<span className="-translate-y-1/2">{format(top)}</span>
					<span>{format(top / 2)}</span>
					<span className="translate-y-1/2">{format(0)}</span>
				</div>
				<div
					ref={area}
					className="relative min-w-0 flex-1"
					style={{ height }}
					onMouseMove={onMouseMove}
					onMouseLeave={onMouseLeave}
				>
					{[0, 50, 100].map((position) => (
						<span
							key={position}
							aria-hidden
							className="pointer-events-none absolute inset-x-0 border-t border-edge"
							style={{ top: `${position}%` }}
						/>
					))}
					{children}
				</div>
			</div>
			<div aria-hidden className="relative ml-11 h-4 text-3xs text-ink-muted tabular-nums">
				{ticks.map((tick) => (
					<span
						key={tick.at}
						className="absolute top-0 whitespace-nowrap"
						style={
							tick.at === 0
								? { left: 0 }
								: tick.at >= count - 1
									? { right: 0 }
									: { left: `${((tick.at + 0.5) / count) * 100}%`, transform: "translateX(-50%)" }
						}
					>
						{tick.label}
					</span>
				))}
			</div>
			{tooltip}
		</div>
	);
}

interface Series {
	readonly label: string;
	readonly color: string;
	/** One value per column, oldest first; undefined is a gap, not a zero. */
	readonly values: ReadonlyArray<number | undefined>;
}

/** The defined points, as [column, value] pairs. */
const pointsOf = (values: ReadonlyArray<number | undefined>) =>
	values.flatMap((value, index) => (value === undefined ? [] : [[index, value] as const]));

/**
 * Lines over time on one axis from zero. A line runs straight across the days it has no value, so
 * a series used now and then still reads as a trend; the tooltip shows those days as empty. Drawn
 * in measured pixels rather than a stretched viewBox, so markers stay round.
 */
export function Lines({
	series,
	titles,
	ticks,
	format,
	label,
	height = 160,
}: {
	readonly series: ReadonlyArray<Series>;
	/** A column's name in its tooltip. */
	readonly titles: ReadonlyArray<string>;
	readonly ticks: ReadonlyArray<{ readonly at: number; readonly label: string }>;
	readonly format: (value: number) => string;
	readonly label: string;
	readonly height?: number;
}) {
	const tip = useTip();
	const area = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	const [hover, setHover] = useState<number | undefined>(undefined);
	useLayoutEffect(() => {
		const box = area.current;
		if (box === null) return;
		const fit = () => setWidth(box.clientWidth);
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(box);
		return () => observer.disconnect();
	}, []);
	const count = titles.length;
	const defined = series.flatMap((line) => line.values.filter((value) => value !== undefined));
	const top = niceMax(Math.max(...defined, 0));
	const x = (index: number) => ((index + 0.5) / count) * width;
	const y = (value: number) => height - (value / top) * height;
	const dot = (key: string, index: number, value: number, color: string, radius: number) => (
		<circle
			key={key}
			cx={x(index)}
			cy={y(value)}
			r={radius}
			strokeWidth={4}
			paintOrder="stroke"
			style={{ fill: color, stroke: "var(--cw-frame)" }}
		/>
	);
	return (
		<Plot
			label={label}
			top={top}
			format={format}
			height={height}
			ticks={ticks}
			count={count}
			area={area}
			onMouseMove={(event) => {
				const box = event.currentTarget.getBoundingClientRect();
				const index = Math.min(
					count - 1,
					Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * count)),
				);
				setHover(index);
				tip.show(
					event,
					<TipRows
						title={titles[index] ?? ""}
						rows={series.map((line) => {
							const value = line.values[index];
							return { label: line.label, value: value === undefined ? "–" : format(value), color: line.color };
						})}
					/>,
				);
			}}
			onMouseLeave={() => {
				setHover(undefined);
				tip.hide();
			}}
			tooltip={tip.element}
		>
			{width > 0 && (
				<svg aria-hidden width={width} height={height} className="absolute inset-0 overflow-visible">
					{hover !== undefined && (
						<line
							x1={Math.round(x(hover)) + 0.5}
							x2={Math.round(x(hover)) + 0.5}
							y1={0}
							y2={height}
							strokeWidth={1}
							style={{ stroke: "var(--cw-edge-focus)" }}
						/>
					)}
					{series.map((line) => {
						const points = pointsOf(line.values);
						const last = points.at(-1);
						return (
							<g key={line.label}>
								<path
									d={points
										.map(([index, value], at) => `${at === 0 ? "M" : "L"}${x(index)} ${y(value)}`)
										.join("")}
									fill="none"
									strokeWidth={2}
									strokeLinejoin="round"
									strokeLinecap="round"
									style={{ stroke: line.color }}
								/>
								{last !== undefined && dot("end", last[0], last[1], line.color, 4)}
								{hover !== undefined &&
									hover !== last?.[0] &&
									line.values[hover] !== undefined &&
									dot("hover", hover, line.values[hover], line.color, 3.5)}
							</g>
						);
					})}
				</svg>
			)}
		</Plot>
	);
}

/** Swatch and name for each series; present whenever a chart has more than one. */
export function Legend({
	items,
}: {
	readonly items: ReadonlyArray<{ readonly label: string; readonly color: string }>;
}) {
	return (
		<ul className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-ink-secondary">
			{items.map((item) => (
				<li key={item.label} className="flex min-w-0 items-center gap-1.5">
					<span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
					<span className="max-w-40 truncate">{item.label}</span>
				</li>
			))}
		</ul>
	);
}

/** A trend at a glance: a 1.5px line over a faint wash, no axes. Decorative; its tile carries the number. */
export function Spark({
	values,
	color = SINGLE,
	className = "h-8 w-full",
}: {
	readonly values: ReadonlyArray<number>;
	readonly color?: string;
	readonly className?: string;
}) {
	const max = Math.max(...values, 0);
	if (values.length < 2 || max === 0)
		return (
			<svg aria-hidden viewBox="0 0 100 32" preserveAspectRatio="none" className={className}>
				<line
					x1="0"
					y1="31"
					x2="100"
					y2="31"
					stroke="var(--cw-edge-focus)"
					strokeWidth="1"
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
		);
	const points = values.map((value, index) => [(index / (values.length - 1)) * 100, 30 - (value / max) * 28] as const);
	const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join("");
	return (
		<svg aria-hidden viewBox="0 0 100 32" preserveAspectRatio="none" className={className} style={{ color }}>
			<path d={`${line}L100 32L0 32Z`} fill="currentColor" opacity="0.1" />
			<path
				d={line}
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinejoin="round"
				strokeLinecap="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

/** Parts of a whole on one line, parted by 2px gaps. Rows too small to see still get a sliver. */
export function Share({
	parts,
	format,
	label,
}: {
	readonly parts: ReadonlyArray<{ readonly label: string; readonly value: number; readonly color: string }>;
	readonly format: (value: number) => string;
	readonly label: string;
}) {
	const tip = useTip();
	const sum = parts.reduce((all, part) => all + part.value, 0);
	return (
		<div role="img" aria-label={label} className="flex h-2 w-full gap-0.5" onMouseLeave={tip.hide}>
			{sum === 0 ? (
				<span className="h-full w-full rounded-[3px]" style={{ backgroundColor: HEAT[0] }} />
			) : (
				parts.map((part) =>
					part.value === 0 ? null : (
						<span
							key={part.label}
							className="h-full min-w-0.5 first:rounded-l-[3px] last:rounded-r-[3px]"
							style={{ flexGrow: (part.value / sum) * 100, flexBasis: 0, backgroundColor: part.color }}
							onMouseMove={(event) =>
								tip.show(
									event,
									<TipRows
										title={part.label}
										rows={[
											{
												label: `${Math.round((part.value / sum) * 100)}% of total`,
												value: format(part.value),
											},
										]}
									/>,
								)
							}
						/>
					),
				)
			)}
			{tip.element}
		</div>
	);
}

/** A value against the largest in its column: the bar a table row carries. */
export function Meter({
	value,
	max,
	color = SINGLE,
}: {
	readonly value: number;
	readonly max: number;
	readonly color?: string;
}) {
	return (
		<span aria-hidden className="block h-1.5 w-full overflow-hidden rounded-full bg-ink/6">
			<span
				className="block h-full rounded-full"
				style={{
					width: `${max === 0 ? 0 : Math.max((value / max) * 100, value > 0 ? 2 : 0)}%`,
					backgroundColor: color,
				}}
			/>
		</span>
	);
}

/**
 * The upper bounds of the lower three heat levels: quartiles of the active values, so one outlier day
 * does not wash out the rest.
 */
export function heatCuts(values: ReadonlyArray<number>): readonly [number, number, number] {
	const active = values.filter((value) => value > 0).toSorted((a, b) => a - b);
	const cut = (share: number) => active[Math.min(active.length - 1, Math.floor(active.length * share))] ?? 0;
	return [cut(0.25), cut(0.5), cut(0.75)];
}

/** A calendar of days, a column per week with Sunday on top, shaded by `heatCuts` levels. */
export function Heat({
	days,
	cuts,
	title,
	onPick,
	picked,
	cell = 11,
}: {
	/** Oldest first; `weekday` 0 is Sunday. */
	readonly days: ReadonlyArray<{ readonly ago: number; readonly weekday: number; readonly value: number }>;
	readonly cuts: readonly [number, number, number];
	readonly title: (day: { readonly ago: number; readonly value: number }) => ReactNode;
	readonly onPick?: (ago: number) => void;
	readonly picked?: number;
	readonly cell?: number;
}) {
	const tip = useTip();
	const level = (value: number) => (value === 0 ? 0 : 1 + cuts.filter((threshold) => value > threshold).length);
	const lead = days[0]?.weekday ?? 0;
	return (
		<div
			className="grid grid-flow-col gap-0.5"
			style={{ gridTemplateRows: `repeat(7, ${cell}px)`, gridAutoColumns: `${cell}px` }}
			onMouseLeave={tip.hide}
		>
			{Array.from({ length: lead }, (_, index) => (
				<span key={`lead-${index}`} aria-hidden />
			))}
			{days.map((day) => {
				const style = { backgroundColor: HEAT[level(day.value)] };
				const className = `rounded-[2px] ${picked === day.ago ? "outline-2 outline-offset-1 outline-ink" : ""}`;
				return onPick === undefined ? (
					<span
						key={day.ago}
						className={className}
						style={style}
						onMouseMove={(event) => tip.show(event, title(day))}
					/>
				) : (
					<button
						key={day.ago}
						type="button"
						tabIndex={-1}
						aria-label={`Day ${day.ago} days ago`}
						aria-pressed={picked === day.ago}
						className={`${className} cursor-pointer outline-ink hover:outline-1 hover:outline-offset-1`}
						style={style}
						onClick={() => onPick(day.ago)}
						onMouseMove={(event) => tip.show(event, title(day))}
					/>
				);
			})}
			{tip.element}
		</div>
	);
}

/** The scale under a heatmap; each step names its range on hover. */
export function HeatScale({
	cuts,
	format,
}: {
	readonly cuts: readonly [number, number, number];
	readonly format: (value: number) => string;
}) {
	const [low, mid, high] = cuts;
	const ranges = [
		"None",
		`Up to ${format(low)}`,
		`${format(low)} – ${format(mid)}`,
		`${format(mid)} – ${format(high)}`,
		`Over ${format(high)}`,
	];
	return (
		<span className="flex items-center gap-1 text-3xs text-ink-muted">
			Less
			{HEAT.map((color, index) => (
				<span
					key={color}
					title={ranges[index]}
					className="size-2.5 rounded-[2px]"
					style={{ backgroundColor: color }}
				/>
			))}
			More
		</span>
	);
}
