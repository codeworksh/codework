import { useAtomSet } from "@effect/atom-react";
import type { RemoteServerStatus } from "@codeworksh/contract";
import { CaretLeftIcon, LinkBreakIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { CopyCommand } from "@/components/copyable";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { messageOf } from "@/lib/utils";
import { Server } from "../../kernel/rpc";
import { removeAtom, updateAtom } from "../../kernel/servers";
import { Group, Page, Placeholder, quietField, Row, SavingInput, Section } from "../blocks";
import { EmptyState } from "../controls";
import { Badge } from "../servers/local";
import { Status, TITLE, usePaired } from "./list";
import { addressOf, PairAgain, urlOf } from "./pair";

const labelAtom = Server.mutation("servers.label");

/** One paired machine, by its id. */
export function PairedMachine({ id }: { id: string }) {
	const paired = usePaired();
	if (!AsyncResult.isSuccess(paired)) {
		return (
			// A blank title holds its line, so nothing moves when the machine arrives.
			<Sub title={" "}>
				{AsyncResult.isFailure(paired) ? (
					<p role="alert" className="text-xs font-book text-ink-muted">
						The app server did not answer.
					</p>
				) : (
					<Placeholder rows={4} />
				)}
			</Sub>
		);
	}
	const server = paired.value.find((each) => each.id === id);
	if (server === undefined) return <Missing />;
	return <Detail server={server} />;
}

/**
 * No paired machine has the id in the address: it was removed, or the link is old. It says so and
 * offers the list, in the card the list itself uses when it is empty.
 */
function Missing() {
	return (
		<div className="relative">
			<Back />
			<div className="mx-auto flex w-full max-w-settings flex-col px-5 pt-16 pb-16 text-ui sm:px-8">
				<h1 className="sr-only">Machine Not Found</h1>
				<EmptyState
					icon={<LinkBreakIcon size={22} aria-hidden />}
					title="Machine Not Found"
					description="It is no longer paired with this computer, or does not exist."
					action={
						<Button size="sm" variant="secondary" asChild>
							<Link to="/settings/paired">View Paired Machines</Link>
						</Button>
					}
				/>
			</div>
		</div>
	);
}

/** The way back to the list, in the panel's top-left corner, outside the content column. */
function Back({ focus = false }: { focus?: boolean }) {
	const back = useRef<HTMLAnchorElement>(null);
	// The link that led here is gone with the list; focus lands on the way back instead of the page.
	useEffect(() => {
		if (focus) back.current?.focus({ preventScroll: true });
	}, [focus]);
	return (
		<Link
			ref={back}
			to="/settings/paired"
			className="absolute top-2.5 left-2 flex h-7 items-center gap-1 rounded-full pr-2.5 pl-1.5 text-ui font-medium text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
		>
			<CaretLeftIcon size={14} className="shrink-0" aria-hidden />
			{TITLE}
		</Link>
	);
}

/**
 * A page under the list. The way back sits in the panel's top-left corner, outside the column, so the
 * title stays where the list's title is.
 */
function Sub({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
	return (
		<div className="relative">
			<Back focus />
			<Page title={title} description={description}>
				{children}
			</Page>
		</div>
	);
}

function Detail({ server }: { server: RemoteServerStatus }) {
	const label = useAtomSet(labelAtom, { mode: "promise" });
	const update = useAtomSet(updateAtom, { mode: "promise" });
	const [labelError, setLabelError] = useState<string | null>(null);
	const [addressError, setAddressError] = useState<string | null>(null);
	const address = addressOf(server.url);
	const readdress = (typed: string) => {
		setAddressError(null);
		const url = urlOf(typed);
		if (url === "") return setAddressError("Enter the Machine's address.");
		if (url === server.url) return;
		update({ payload: { id: server.id, url } }).catch((cause: unknown) => setAddressError(messageOf(cause)));
	};
	return (
		<Sub title={server.name} description={<Status server={server} />}>
			{!server.paired && (
				<Section title="Pair Again" description="This computer is no longer paired with it.">
					<Group>
						<PairAgain server={server} />
					</Group>
				</Section>
			)}
			<Section title="Machine">
				<Group>
					<Row title="Label" description={labelError ?? "Stored on the Machine. Shown wherever it appears."}>
						<SavingInput
							label="Machine label"
							value={server.label ?? ""}
							placeholder={server.host ?? undefined}
							className={`w-full @min-[560px]:w-64 ${quietField}`}
							onCommit={(next) => {
								setLabelError(null);
								label({ payload: { id: server.id, label: next } }).catch((cause: unknown) =>
									setLabelError(messageOf(cause)),
								);
							}}
						/>
					</Row>
					<Row title="Hostname" description="The computer's own name.">
						{server.host ? (
							<div className="w-full min-w-0 shrink-0 @min-[560px]:w-auto @min-[560px]:max-w-64">
								<CopyCommand command={server.host} label="Copy Hostname" />
							</div>
						) : (
							<Badge tone="muted">Unknown</Badge>
						)}
					</Row>
					<Row title="Address" description={addressError ?? "Where this computer reaches it."}>
						<SavingInput
							label="Machine address"
							value={address}
							placeholder="host or host:port"
							className={`w-full font-mono text-xs text-ellipsis @min-[560px]:w-64 md:text-xs ${quietField}`}
							onCommit={readdress}
						/>
					</Row>
					<Row title="Version">
						{server.version ? (
							<span className="font-mono text-xs text-ink-muted">v{server.version}</span>
						) : (
							<span className="text-xs text-ink-muted">Unknown</span>
						)}
					</Row>
				</Group>
			</Section>
			<Section title="Remove">
				<Group>
					<Row
						title="Remove from This Computer"
						description="Its threads leave the sidebar. Nothing on the Machine is deleted."
					>
						<Remove server={server} />
					</Row>
				</Group>
			</Section>
		</Sub>
	);
}

/** Forgets the machine here, once confirmed, and goes back to the list. */
function Remove({ server }: { server: RemoteServerStatus }) {
	const remove = useAtomSet(removeAtom, { mode: "promise" });
	const navigate = useNavigate();
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const confirm = () => {
		setBusy(true);
		setError(null);
		remove({ payload: { id: server.id } })
			.then(() => navigate({ to: "/settings/paired" }))
			.catch((cause: unknown) => {
				setBusy(false);
				setError(messageOf(cause));
			});
	};
	return (
		<>
			<Button
				size="sm"
				variant="secondary"
				className="text-destructive hover:text-destructive"
				onClick={() => {
					setError(null);
					setAsking(true);
				}}
			>
				Remove…
			</Button>
			<AlertDialog open={asking} onOpenChange={(next) => !busy && setAsking(next)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="wrap-break-word">Remove {server.name}?</AlertDialogTitle>
						<AlertDialogDescription>
							Its threads leave this computer's sidebar. Nothing on the Machine is deleted, and it can be paired
							again.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{error !== null && <p className="text-xs text-destructive">{error}</p>}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={busy}
							onClick={(event) => {
								// Held open until the call returns, so a failure shows here.
								event.preventDefault();
								confirm();
							}}
						>
							{busy ? "Removing…" : "Remove"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
