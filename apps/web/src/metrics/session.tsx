import { Monogram } from "@/components/monogram";
import { Meter } from "./charts";
import { formatCost, formatCount, formatTokens, type Listed } from "./data";

/**
 * One session on one line (two when narrow): title, then project and threads, then a meter against
 * the list's top line by `by`, which also takes the ink. Deleted sessions are one muted line.
 */
export function SessionLine({
	line,
	by,
	max,
}: {
	readonly line: Listed;
	readonly by: "tokens" | "cost";
	/** The list's top value of `by`, for the meter. */
	readonly max: number;
}) {
	const tone = (key: "tokens" | "cost") => (key === by ? "text-ink" : "text-ink-secondary");
	const title =
		line.kind === "deleted"
			? `${formatCount(line.count)} Deleted ${line.count === 1 ? "Session" : "Sessions"}`
			: line.session.title;
	return (
		<li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 border-t border-edge/50 py-2 first:border-t-0 @2xl:grid-cols-[minmax(0,1fr)_auto_auto]">
			<span
				title={title}
				className={`min-w-0 truncate text-ui ${line.kind === "deleted" ? "text-ink-muted" : "text-ink"}`}
			>
				{title}
			</span>
			{line.kind === "session" && (
				<span className="col-span-2 row-start-2 flex min-w-0 items-center gap-x-3 text-2xs text-ink-secondary @2xl:col-span-1 @2xl:col-start-2 @2xl:row-start-1">
					<span title={line.session.project.name} className="flex max-w-40 min-w-0 items-center gap-1.5">
						<Monogram id={line.session.project.id} name={line.session.project.name} />
						<span className="min-w-0 truncate">{line.session.project.name}</span>
					</span>
					{line.threads !== undefined && (
						<span className="shrink-0 text-ink-muted tabular-nums">
							{formatCount(line.threads)} {line.threads === 1 ? "Thread" : "Threads"}
						</span>
					)}
				</span>
			)}
			<span className="col-start-2 row-start-1 flex items-center gap-3 @2xl:col-start-3">
				<span className="hidden w-24 @md:block">
					<Meter value={line[by]} max={max} />
				</span>
				<span className={`w-14 text-right text-ui tabular-nums ${tone("tokens")}`}>
					{formatTokens(line.tokens)}
				</span>
				<span className={`w-16 text-right text-ui tabular-nums ${tone("cost")}`}>{formatCost(line.cost)}</span>
			</span>
		</li>
	);
}
