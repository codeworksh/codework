import { ArrowClockwiseIcon, ArrowCounterClockwiseIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_SERVER_HEALTH } from "@codeworksh/contract";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { messageOf } from "@/lib/utils";
import { Server } from "../../kernel/rpc";
import { serversAtom } from "../../kernel/servers";
import { quietField, Row, SavingInput } from "../blocks";

const checkAtom = Server.mutation("servers.check");
const healthKey = ["health"];
const healthAtom = Server.query("servers.health", undefined, { reactivityKeys: healthKey });
const setHealthAtom = Server.mutation("servers.setHealth");

/** Checks every machine now; the statuses show when it last happened. */
export function CheckAgain() {
	const [check, runCheck] = useAtom(checkAtom);
	const servers = useAtomValue(serversAtom);
	const checking = check.waiting;
	return (
		<Button
			size="sm"
			variant="ghost"
			title="Check Again"
			aria-label="Check every machine again"
			disabled={checking}
			className="text-ink-muted"
			onClick={() => runCheck({ payload: undefined })}
		>
			<ArrowClockwiseIcon
				className={`size-3.5 ${checking ? "animate-spin motion-reduce:animate-none" : ""}`}
				aria-hidden
			/>
			<span className="hidden @min-[640px]:inline">
				{checking ? "Checking…" : <Checked at={AsyncResult.isSuccess(servers) ? servers.value : undefined} />}
			</span>
		</Button>
	);
}

const STEP = 30;

/** How often every machine is checked again in the background, in seconds; 0 turns it off. */
export function HealthInterval() {
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
					Health Check Interval
					{/* Always there and only shown off the default, so the row never changes height. */}
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label="Reset health check interval to default"
						title="Reset to Default"
						disabled={interval === undefined || interval === DEFAULT_SERVER_HEALTH.interval}
						className="-my-1 disabled:invisible"
						onClick={() => set(DEFAULT_SERVER_HEALTH.interval)}
					>
						<ArrowCounterClockwiseIcon />
					</Button>
				</span>
			}
			description={error ?? "Refresh this machine’s CLI and every machine’s response time, or set 0 to turn it off"}
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
	if (minutes < 1) return "Checked Just Now";
	return minutes < 60 ? `Checked ${minutes}m Ago` : `Checked ${Math.floor(minutes / 60)}h Ago`;
}
