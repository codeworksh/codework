import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_SERVER_HEALTH } from "@codeworksh/contract";
import { Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { messageOf } from "@/lib/utils";
import { Server } from "../../kernel/rpc";
import { serversAtom } from "../../kernel/servers";
import { Group, Page, quietField, Row, SavingInput, Section } from "../blocks";
import { AddServer } from "./add";
import { LocalDetail, LocalItem } from "./local";

const checkAtom = Server.mutation("servers.check");
const healthKey = ["health"];
const healthAtom = Server.query("servers.health", undefined, { reactivityKeys: healthKey });
const setHealthAtom = Server.mutation("servers.setHealth");

/** The CodeWork servers the app can work with, listed beside the one selected; the built-in one is always there. */
export function ServersSettings() {
	const result = useAtomValue(serversAtom);
	const [check, runCheck] = useAtom(checkAtom);
	const checking = check.waiting;
	const servers = AsyncResult.isSuccess(result) ? result.value : undefined;
	// The status is held from launch (see the root route), so opening the page shows it at once and
	// checks again behind it.
	useEffect(() => runCheck({ payload: undefined }), []);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	// The default until one is picked, and again when the picked one is gone.
	const selected = servers?.find((server) => server.id === selectedId) ?? servers?.find((server) => server.isDefault);
	// Shown as the new server's executable default: the binary found without a choice.
	const detected = servers?.flatMap((server) =>
		server.cli !== null && !server.cli.custom ? [server.cli.path] : [],
	)[0];

	return (
		<Page
			title="Providers"
			actions={
				<button
					type="button"
					title="Check again"
					disabled={checking}
					className="flex items-center gap-1.5 rounded-md px-2 py-1 text-ink-muted transition-colors hover:bg-muted hover:text-ink disabled:pointer-events-none"
					onClick={() => runCheck({ payload: undefined })}
				>
					<RefreshCw className={`size-3.5 ${checking ? "animate-spin" : ""}`} aria-hidden />
					{checking ? "Checking…" : <Checked at={servers} />}
				</button>
			}
		>
			<div className="@container">
				{/* Side by side, the split keeps a fixed height and each side scrolls on its own; stacked, the page scrolls. */}
				<div className="grid items-start rounded-lg border border-edge/60 @3xl:h-[min(44rem,calc(100dvh-12.5rem))] @3xl:min-h-128 @3xl:grid-cols-[16rem_minmax(0,1fr)] @3xl:items-stretch @3xl:overflow-hidden">
					<nav
						aria-label="Providers"
						className="flex flex-col border-edge/60 @max-3xl:border-b @3xl:min-h-0 @3xl:overflow-y-auto @3xl:border-r"
					>
						{servers?.map((server) => (
							<button
								key={server.id}
								type="button"
								aria-current={server.id === selected?.id ? "true" : undefined}
								className={`border-b border-edge pr-5 text-left transition-colors ${server.id === selected?.id ? "bg-ink/4" : "hover:bg-ink/3"}`}
								onClick={() => setSelectedId(server.id)}
							>
								<LocalItem status={server} />
							</button>
						))}
						<button
							type="button"
							className="flex items-center gap-3 px-5 py-4 text-left text-ink-muted transition-colors hover:bg-ink/3 hover:text-ink"
							onClick={() => setAdding(true)}
						>
							<Plus className="size-4" aria-hidden />
							Add Provider
						</button>
					</nav>
					{/* Mounted only while open, so each opening starts fresh and is named after the servers there are. */}
					{adding && (
						<AddServer
							onClose={() => setAdding(false)}
							defaultName={`CodeWork ${(servers?.length ?? 0) + 1}`}
							detected={detected}
							onAdded={setSelectedId}
						/>
					)}
					<div className="min-w-0 @3xl:min-h-0 @3xl:overflow-y-auto">
						{selected !== undefined ? (
							<LocalDetail key={selected.id} status={selected} />
						) : AsyncResult.isFailure(result) ? (
							<p className="p-6 text-ink-muted">The app server did not answer.</p>
						) : (
							<div className="flex flex-col gap-3 p-6">
								<Skeleton className="h-5 w-1/3" />
								<Skeleton className="h-24 w-full" />
								<Skeleton className="h-40 w-full" />
							</div>
						)}
					</div>
				</div>
			</div>
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
						<Undo2 />
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
							<Minus />
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
							<Plus />
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
