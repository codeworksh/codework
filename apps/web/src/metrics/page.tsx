import { MetricsError, type MetricsUsage } from "@codeworksh/contract";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { ChartBarIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Option } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";
import { useMemo, useState, useSyncExternalStore } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { minuteTick } from "../kernel/clock";
import { Page } from "../shell/page";
import { Segmented } from "./charts";
import {
	localDay,
	projectOptions,
	query,
	RANGES,
	type RangeKey,
	type Scope,
	usageAtom,
	usageKey,
	yearOf,
} from "./data";
import { MachineSelect, ProjectSelect } from "./filters";
import { MetricsBody } from "./metrics";

const EVERYTHING: Scope = { machineId: null, projectId: null };

/** The period and filters, kept across navigation so coming back shows the same view. */
const viewAtom = Atom.make<Scope & { readonly range: RangeKey }>({ range: "30d", ...EVERYTHING }).pipe(Atom.keepAlive);

/**
 * The year of usage for `scope`, read again on every change to it. A new scope or day keeps the last
 * year on screen until its own arrives; each year is indexed against the day it was read for.
 */
function useYear(scope: Scope, today: string) {
	const atom = usageAtom(usageKey(scope, today));
	const result = useAtomValue(atom);
	const retry = useAtomRefresh(atom);
	const current = Option.getOrUndefined(AsyncResult.value(result));
	const [kept, setKept] = useState<{ readonly usage: MetricsUsage; readonly today: string }>();
	if (current !== undefined && current !== kept?.usage) setKept({ usage: current, today });
	const usage = current ?? kept?.usage;
	const day = current === undefined ? kept?.today : today;
	const year = useMemo(
		() => (usage === undefined || day === undefined ? undefined : yearOf(usage, day)),
		[usage, day],
	);
	const error = Option.getOrUndefined(AsyncResult.error(result));
	const failure = !AsyncResult.isFailure(result)
		? undefined
		: error instanceof MetricsError
			? error.message
			: "The App Server Is Unreachable";
	return { year, failure, retry };
}

/** Usage across machines and projects; the header's filters and period scope everything below. */
export function MetricsPage() {
	const [{ range, machineId: picked, projectId }, setView] = useAtom(viewAtom);
	const setRange = (next: RangeKey) => setView((view) => ({ ...view, range: next }));
	const setMachineId = (next: string | null) => setView((view) => ({ ...view, machineId: next }));
	const setProjectId = (next: string | null) => setView((view) => ({ ...view, projectId: next }));
	const today = localDay(new Date(useSyncExternalStore(minuteTick.subscribe, minuteTick.getSnapshot)));
	// Filtered reads name only what they cover, so the filters list from the unfiltered year: the same read when nothing is filtered.
	const unfiltered = useYear(EVERYTHING, today).year;
	// A machine removed since it was picked is no longer listed: every machine shows instead.
	const machineId = unfiltered?.machines.some((machine) => machine.id === picked) === false ? null : picked;
	const scope = useMemo(() => ({ machineId, projectId }), [machineId, projectId]);
	const { year, failure, retry } = useYear(scope, today);
	const everything = unfiltered ?? year;
	const metrics = useMemo(() => (year === undefined ? undefined : query(year, range)), [year, range]);
	const whole = useMemo(() => (year === undefined ? undefined : query(year, "1y")), [year]);
	const projects = useMemo(
		() => (everything === undefined ? [] : projectOptions(everything, range, machineId)),
		[everything, range, machineId],
	);
	const machines = everything?.machines ?? [];

	return (
		<Page
			instanceId="metrics"
			title="Metrics"
			icon={ChartBarIcon}
			actions={
				<>
					{machines.length > 1 && <MachineSelect value={machineId} onChange={setMachineId} machines={machines} />}
					<ProjectSelect value={projectId} onChange={setProjectId} options={projects} />
					<Segmented options={RANGES} value={range} onChange={setRange} label="Period" />
				</>
			}
		>
			<div className="@container h-full overflow-y-auto">
				{failure !== undefined && <Failed detail={failure} onRetry={retry} alone={metrics === undefined} />}
				{metrics !== undefined && whole !== undefined ? (
					<MetricsBody
						year={whole}
						metrics={metrics}
						scope={scope}
						projectName={projects.find((row) => row.project.id === projectId)?.project.name}
						onProject={setProjectId}
					/>
				) : (
					failure === undefined && <Loading />
				)}
			</div>
		</Page>
	);
}

/** What failed and a way to try again: in place of the page with nothing to show, or above what is shown. */
function Failed({
	detail,
	onRetry,
	alone,
}: {
	readonly detail: string;
	readonly onRetry: () => void;
	/** Nothing is shown below it. */
	readonly alone: boolean;
}) {
	return (
		<div
			role="status"
			className={
				alone
					? "flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
					: "mx-auto flex max-w-[1100px] items-center gap-2 px-6 pt-6 text-2xs"
			}
		>
			<span className={alone ? "flex flex-col items-center gap-1" : "flex min-w-0 items-center gap-1.5"}>
				<span className="flex shrink-0 items-center gap-1.5 text-ui font-medium text-ink">
					<WarningCircleIcon size={16} className="shrink-0 text-ink-muted" aria-hidden />
					Could Not Load Metrics
				</span>
				<span title={detail} className="min-w-0 truncate text-2xs text-ink-muted">
					{detail}
				</span>
			</span>
			<button
				type="button"
				onClick={onRetry}
				className="h-7 shrink-0 rounded-md border border-edge px-2 text-xs text-ink outline-none hover:bg-selection-subtle focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
			>
				Retry
			</button>
		</div>
	);
}

/** The first cards' shapes at their sizes, until the first year arrives. */
function Loading() {
	const card = "flex flex-col gap-4 rounded-lg border border-edge p-4";
	return (
		<div aria-hidden className="mx-auto flex max-w-[1100px] flex-col gap-4 px-6 py-6">
			<div className="grid grid-cols-1 gap-4 @lg:grid-cols-3">
				{[0, 1, 2].map((tile) => (
					<div key={tile} className="flex h-[146px] flex-col gap-2 rounded-lg border border-edge p-4">
						<Skeleton className="h-3 w-12" />
						<Skeleton className="h-6 w-24" />
						<Skeleton className="mt-auto h-8 w-full" />
					</div>
				))}
			</div>
			{[330, 290].map((height) => (
				<div key={height} className={card} style={{ height }}>
					<Skeleton className="h-4 w-28" />
					<Skeleton className="w-full flex-1" />
				</div>
			))}
			<div className="grid gap-4 @3xl:grid-cols-2">
				{[0, 1].map((half) => (
					<div key={half} className={`${card} h-[260px]`}>
						<Skeleton className="h-4 w-20" />
						<Skeleton className="h-2 w-full" />
						<Skeleton className="w-full flex-1" />
					</div>
				))}
			</div>
		</div>
	);
}
