import { useClerk } from "@clerk/electron/react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState, useSyncExternalStore } from "react";

import { isSignedInApp } from "../auth";
import { isSignedOut, isTransient, meAtom, reachAtom } from "../kernel/relay";

type Connection = "ok" | "offline" | "unreachable" | "unavailable" | "signedOut";

const LABELS: Record<Exclude<Connection, "ok">, { readonly label: string; readonly detail: string }> = {
	offline: { label: "Offline", detail: "This device is offline. Workspaces show Relay’s last status." },
	unreachable: {
		label: "Can’t Reach Relay",
		detail: "Relay servers aren’t answering. Workspaces show their last status.",
	},
	unavailable: {
		label: "Sign-In Unavailable",
		detail: "CodeWork’s sign-in service isn’t responding. Workspaces show Relay’s last status.",
	},
	signedOut: { label: "Signed Out", detail: "Your sign-in expired." },
};

const subscribeOnline = (notify: () => void) => {
	window.addEventListener("online", notify);
	window.addEventListener("offline", notify);
	return () => {
		window.removeEventListener("online", notify);
		window.removeEventListener("offline", notify);
	};
};

/** Whether CodeWork's servers can be used now, from the device's network, the last relay call and the account. */
function useConnection(): Connection {
	const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine);
	const reach = useAtomValue(reachAtom);
	const me = useAtomValue(meAtom);
	if (!online) return "offline";
	if (AsyncResult.isFailure(me) && isSignedOut(me.cause)) return "signedOut";
	if (reach !== "ok") return reach;
	if (AsyncResult.isFailure(me) && isTransient(me.cause)) return "unavailable";
	return "ok";
}

/**
 * The one place the app says CodeWork's servers can't be used: a dot, the state, and Reconnect. Nothing
 * while they can. While they can't, it asks again every few seconds, when the window comes back and when
 * the network does; the rest of the app keeps what it last heard.
 */
export function ConnectionStatus() {
	if (!isSignedInApp) return null;
	return <Status />;
}

function Status() {
	const connection = useConnection();
	const refreshMe = useAtomRefresh(meAtom);
	const clerk = useClerk();
	const [reconnecting, setReconnecting] = useState(false);
	const down = connection !== "ok" && connection !== "signedOut";

	useEffect(() => {
		if (!down) return;
		window.addEventListener("focus", refreshMe);
		window.addEventListener("online", refreshMe);
		const timer = setInterval(refreshMe, 3_000);
		return () => {
			window.removeEventListener("focus", refreshMe);
			window.removeEventListener("online", refreshMe);
			clearInterval(timer);
		};
	}, [down, refreshMe]);

	// "Reconnecting…" holds long enough to read, then the slot shows what the attempt found.
	useEffect(() => {
		if (!reconnecting) return;
		const timer = setTimeout(() => setReconnecting(false), 1_500);
		return () => clearTimeout(timer);
	}, [reconnecting]);

	if (connection === "ok") return null;
	const { label, detail } = LABELS[connection];
	return (
		<div role="status" className="flex min-w-0 items-center gap-1.5 pl-1.5 text-xs" title={detail}>
			<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
			<span className="truncate font-mono font-medium text-destructive">{label}</span>
			{connection === "signedOut" ? (
				<button
					type="button"
					onClick={() => void clerk.signOut()}
					className="shrink-0 rounded-md px-1.5 py-1 font-medium text-ink outline-none hover:bg-selection-subtle focus-visible:ring-2 focus-visible:ring-ring"
				>
					Sign In
				</button>
			) : (
				<button
					type="button"
					disabled={reconnecting}
					onClick={() => {
						setReconnecting(true);
						refreshMe();
					}}
					className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-ink outline-none hover:bg-selection-subtle focus-visible:ring-2 focus-visible:ring-ring disabled:text-ink-muted"
				>
					<ArrowClockwiseIcon
						size={12}
						aria-hidden
						className={reconnecting ? "animate-spin motion-reduce:animate-none" : ""}
					/>
					{reconnecting ? "Reconnecting…" : "Reconnect"}
				</button>
			)}
		</div>
	);
}
