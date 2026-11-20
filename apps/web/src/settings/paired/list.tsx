import { useAtomValue } from "@effect/atom-react";
import type { RemoteServerStatus, ServerStatus } from "@codeworksh/contract";
import { CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { serversAtom } from "../../kernel/servers";
import { Group, Page, Placeholder } from "../blocks";
import { Done, EmptyState, SeenStatus, StatusDot } from "../controls";
import { addressOf, PairDialog } from "./pair";

export const TITLE = "Paired Machines";

const isPaired = (server: ServerStatus): server is RemoteServerStatus => server.kind === "remote";

/** This computer's paired machines, kept current. */
export function usePaired() {
	return AsyncResult.map(useAtomValue(serversAtom), (servers) => servers.filter(isPaired));
}

/** Whether it is paired, then whether it answers. */
export function Status({ server }: { server: RemoteServerStatus }) {
	return server.paired ? (
		<SeenStatus online={server.online} seenAt={server.seenAt} />
	) : (
		<StatusDot tone="warning">Not Paired</StatusDot>
	);
}

export function PairedList() {
	const paired = usePaired();
	const [pairing, setPairing] = useState(false);
	// The dialog unmounts rather than closing, so focus is handed back to its button by hand.
	const opener = useRef<HTMLButtonElement>(null);
	const close = () => {
		setPairing(false);
		requestAnimationFrame(() => opener.current?.focus());
	};
	// The machine paired a moment ago, marked where it landed.
	const [fresh, setFresh] = useState<string | null>(null);
	useEffect(() => {
		if (fresh === null) return;
		const timer = setTimeout(() => setFresh(null), 2400);
		return () => clearTimeout(timer);
	}, [fresh]);
	return (
		<Page
			title={TITLE}
			description="Machines this computer reaches with a pairing code, outside any Workspace."
			actions={
				<Button ref={opener} size="sm" onClick={() => setPairing(true)}>
					<PlusIcon aria-hidden />
					Pair a Machine
				</Button>
			}
		>
			{AsyncResult.isSuccess(paired) ? (
				paired.value.length === 0 ? (
					<EmptyState
						title="No Paired Machines"
						description="A Machine you pair shows up here, and its threads in the sidebar."
					/>
				) : (
					<Group>
						{paired.value.map((server) => (
							<Item key={server.id} server={server} fresh={server.id === fresh} />
						))}
					</Group>
				)
			) : AsyncResult.isFailure(paired) ? (
				<p role="alert" className="text-xs font-book text-ink-muted">
					The app server did not answer.
				</p>
			) : (
				<Placeholder rows={3} />
			)}
			{pairing && (
				<PairDialog
					onClose={close}
					onPaired={(id) => {
						close();
						setFresh(id);
					}}
				/>
			)}
		</Page>
	);
}

function Item({ server, fresh }: { server: RemoteServerStatus; fresh: boolean }) {
	const address = addressOf(server.url);
	return (
		<Link
			to="/settings/paired/$id"
			params={{ id: server.id }}
			className={`flex min-h-15 w-full items-center gap-4 px-4 py-3 text-left outline-none first:rounded-t-[10px] last:rounded-b-[10px] hover:bg-ink/3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset transition-colors duration-700 ease-out hover:duration-150 motion-reduce:transition-none ${fresh ? "bg-selection-subtle" : ""}`}
		>
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="truncate font-medium" title={server.name}>
					{server.name}
				</span>
				<span className="truncate text-xs font-book text-ink-muted" title={address}>
					{address}
				</span>
			</span>
			<span className="shrink-0">{fresh ? <Done>Paired</Done> : <Status server={server} />}</span>
			<CaretRightIcon size={12} className="shrink-0 text-ink-muted" aria-hidden />
		</Link>
	);
}
