import { ArrowClockwiseIcon, ArrowCounterClockwiseIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_SERVER_HEALTH, LOCAL_SERVER, type LocalServerStatus } from "@codeworksh/contract";

import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { messageOf } from "@/lib/utils";
import { Server } from "../../kernel/rpc";
import { serversAtom } from "../../kernel/servers";
import { Group, Page, quietField, Row, SavingInput, Section } from "../blocks";
import { AddServer } from "./add";
import { LocalDetail, LocalItem, reportedName } from "./local";

const checkAtom = Server.mutation("servers.check");
const healthKey = ["health"];
const healthAtom = Server.query("servers.health", undefined, { reactivityKeys: healthKey });
const setHealthAtom = Server.mutation("servers.setHealth");

/** The CodeWork servers the app can work with, listed beside the one selected; the built-in one is always there. */
export function ServersSettings() {
	const result = useAtomValue(serversAtom);
	const [check, runCheck] = useAtom(checkAtom);
	const checking = check.waiting;
	// Remote servers are not shown here yet.
	const servers = AsyncResult.isSuccess(result)
		? result.value.filter((server): server is LocalServerStatus => server.kind === "local")
		: undefined;
	// The status is held from launch (see the root route), so opening the page shows it at once and
	// checks again behind it.
	useEffect(() => runCheck({ payload: undefined }), []);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	// The default until one is picked, and again when the picked one is gone.
	const selected = servers?.find((server) => server.id === selectedId) ?? servers?.find((server) => server.isDefault);
	// A new local server runs on the same machine, so it reports the built-in one's name.
	const builtin = servers?.find((server) => server.id === LOCAL_SERVER);
	// Shown as the new server's executable default: the binary found without a choice.
	const detected = servers?.flatMap((server) =>
		server.cli !== null && !server.cli.custom ? [server.cli.path] : [],
	)[0];

	return (
		<Page
			title="Providers"
			description="Manage the CodeWork servers that run your sessions."
			actions={
				<div className="flex items-center gap-2">
					<Button
						size="sm"
						variant="ghost"
						title="Check again"
						aria-label="Check provider status"
						disabled={checking}
						className="text-ink-muted"
						onClick={() => runCheck({ payload: undefined })}
					>
						<ArrowClockwiseIcon className={`size-3.5 ${checking ? "animate-spin" : ""}`} aria-hidden />
						<span className="hidden @min-[640px]:inline">
							{checking ? "Checking…" : <Checked at={servers} />}
						</span>
					</Button>
					<Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
						<PlusIcon aria-hidden />
						Add Provider
					</Button>
				</div>
			}
		>
			<Section title="Your providers">
				<nav aria-label="Providers" className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-2">
					{servers?.map((server) => (
						<button
							key={server.id}
							type="button"
							aria-current={server.id === selected?.id ? "true" : undefined}
							className="min-w-0 rounded-xl border border-edge p-4 text-left outline-none hover:border-edge-focus focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-frame aria-current:border-brand aria-current:bg-brand/4"
							onClick={() => setSelectedId(server.id)}
						>
							<LocalItem status={server} />
						</button>
					))}
				</nav>
			</Section>
			{adding && (
				<AddServer
					onClose={() => setAdding(false)}
					placeholder={builtin && reportedName(builtin)}
					detected={detected}
					onAdded={setSelectedId}
				/>
			)}
			{selected !== undefined ? (
				<LocalDetail key={selected.id} status={selected} />
			) : AsyncResult.isFailure(result) ? (
				<p role="alert" className="rounded-lg border border-edge p-4 text-ink-muted">
					The app server did not answer.
				</p>
			) : (
				<div className="flex flex-col gap-3">
					<Skeleton className="h-5 w-1/3" />
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-40 w-full" />
				</div>
			)}
			<Section title="Advanced">
				<Group>
					<HealthInterval />
				</Group>
			</Section>
		</Page>
	);
}

const STEP = 30;

/** How often the servers are checked again in the background, in seconds; 0 turns it off. */
function HealthInterval() {
	const result = useAtomValue(healthAtom);
	const save = useAtomSet(setHealthAtom, { mode: "promise" });
	const [error, setError] = useState<string | null>(null);
	const interval = AsyncResult.isSuccess(result) ? result.value.interval : undefined;
	const set = (seconds: number) => {
		setError(null);
		save({ payload: { interval: seconds }, reactivityKeys: healthKey }).catch((cause: unknown) =>
			setError(messageOf(cause)),
		);
	};
	const commit = (typed: string) => {
		const seconds = Number(typed);
		if (!Number.isInteger(seconds) || seconds < 0) return setError("Use whole seconds, or 0 to turn it off.");
		set(seconds);
	};
	return (
		<Row
			title={
				<span className="inline-flex items-center gap-1.5">
					Health check interval
					{/* Always there and only shown off the default, so the row never changes height. */}
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label="Reset health check interval to default"
						title="Reset to default"
						disabled={interval === undefined || interval === DEFAULT_SERVER_HEALTH.interval}
						className="-my-1 disabled:invisible"
						onClick={() => set(DEFAULT_SERVER_HEALTH.interval)}
					>
						<ArrowCounterClockwiseIcon />
					</Button>
				</span>
			}
			description={error ?? "Refresh provider status and versions in the background. Set to 0 to disable."}
		>
			{interval !== undefined && (
				<div className="flex shrink-0 items-center gap-2">
					<div className="flex items-center">
						<Button
							size="icon-xs"
							variant="ghost"
							aria-label="Decrease health check interval"
							disabled={interval === 0}
							onClick={() => set(Math.max(0, interval - STEP))}
						>
							<MinusIcon />
						</Button>
						<SavingInput
							value={String(interval)}
							label="Health check interval in seconds"
							className={`${quietField} h-7 w-16 text-center`}
							onCommit={commit}
						/>
						<Button
							size="icon-xs"
							variant="ghost"
							aria-label="Increase health check interval"
							onClick={() => set(interval + STEP)}
						>
							<PlusIcon />
						</Button>
					</div>
					<span className="text-xs text-ink-muted">seconds</span>
				</div>
			)}
		</Row>
	);
}

/** "Checked 2m ago", counted from when this status arrived and kept current while it shows. */
function Checked({ at }: { at: object | undefined }) {
	const [since, setSince] = useState(() => Date.now());
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		setSince(Date.now());
		setNow(Date.now());
	}, [at]);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);
	const minutes = Math.floor((now - since) / 60_000);
	if (minutes < 1) return "Checked just now";
	return minutes < 60 ? `Checked ${minutes}m ago` : `Checked ${Math.floor(minutes / 60)}h ago`;
}
