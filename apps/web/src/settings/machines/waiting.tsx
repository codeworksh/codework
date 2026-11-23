import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { Relay } from "@codeworksh/schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { Collapse } from "@/components/collapse";
import { CopyCommand } from "@/components/copyable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { approveAtom, declineAtom, machinesAtom, pairingsAtom, relayFailure } from "../../kernel/relay";
import { Group, Row, Section } from "../blocks";
import { Done } from "../controls";
import { shortId } from "./shared";

/** How often pending connects are asked for: a person is usually waiting at the other machine. */
const PENDING_MS = 5_000;

/** Machines that ran `codework connect --workspace` for this workspace, each with the code to check. */
export function Waiting({ workspace }: { readonly workspace: Relay.Workspace }) {
	const pairings = useAtomValue(pairingsAtom(workspace.id));
	const refreshPairings = useAtomRefresh(pairingsAtom(workspace.id));
	const refreshMachines = useAtomRefresh(machinesAtom(workspace.id));
	const approve = useAtomSet(approveAtom, { mode: "promise" });
	const decline = useAtomSet(declineAtom, { mode: "promise" });
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const timer = setInterval(refreshPairings, PENDING_MS);
		return () => clearInterval(timer);
	}, [refreshPairings]);

	const list = AsyncResult.isSuccess(pairings) ? pairings.value : [];
	// A connect leaves the list once its machine takes the link (or gives up): the machines list moves.
	const codes = list.map((pairing) => pairing.userCode).join(" ");
	const previous = useRef(codes);
	useEffect(() => {
		const now = new Set(codes.split(" "));
		if (previous.current.split(" ").some((code) => code !== "" && !now.has(code))) refreshMachines();
		previous.current = codes;
	}, [codes, refreshMachines]);
	const act = (pairing: Relay.PendingPairing, how: "approve" | "decline") => {
		setBusy((codes) => new Set(codes).add(pairing.userCode));
		setError(null);
		const input = { userCode: pairing.userCode, workspaceId: workspace.id };
		(how === "approve" ? approve(input) : decline(input))
			.then(() => {
				refreshPairings();
				refreshMachines();
			})
			.catch((cause: unknown) => setError(relayFailure(cause)))
			.finally(() =>
				setBusy((codes) => {
					const next = new Set(codes);
					next.delete(pairing.userCode);
					return next;
				}),
			);
	};
	const command = `codework connect --workspace ${workspace.id}`;
	return (
		<Section
			title={`Waiting to Join ${workspace.name}`}
			count={list.length}
			description="Machines that asked to join and are waiting for approval"
		>
			<Group>
				{list.map((pairing) => {
					const approved = pairing.status === "approved";
					const working = busy.has(pairing.userCode) || approved;
					return (
						<div
							key={pairing.userCode}
							className="animate-in duration-300 ease-(--ease-out) fade-in-0 slide-in-from-top-1 motion-reduce:animate-none"
						>
							<Row
								title={
									<span
										className="block truncate"
										title={pairing.machine.givenName ?? pairing.machine.localHostName}
									>
										{pairing.machine.givenName ?? pairing.machine.localHostName}
									</span>
								}
								description={
									<>
										{pairing.machine.os} {pairing.machine.arch} ·{" "}
										<span className="tabular-nums" title={pairing.machine.id}>
											{shortId(pairing.machine.id)}
										</span>{" "}
										· Code <code className="font-mono tracking-wider text-ink">{pairing.userCode}</code>
										{pairing.replaces && <> · Replaces the connected machine</>}
									</>
								}
							>
								<div className="flex shrink-0 items-center gap-1">
									<Button size="sm" variant="ghost" disabled={working} onClick={() => act(pairing, "decline")}>
										Decline
									</Button>
									<Button
										size="sm"
										className="min-w-24"
										disabled={working}
										onClick={() => act(pairing, "approve")}
									>
										{approved ? "Connecting…" : working ? "Approving…" : "Approve"}
									</Button>
								</div>
							</Row>
						</div>
					);
				})}
				<div className="flex flex-col gap-2 px-4 py-3.5">
					<span className="text-xs font-book text-ink-muted">
						Run this on a machine, then approve its code here
					</span>
					<CopyCommand command={command} />
					{error !== null && <p className="text-xs text-destructive">{error}</p>}
					<ManualCode workspace={workspace} onAdded={refreshMachines} />
				</div>
			</Group>
		</Section>
	);
}

/**
 * The way in for a machine that isn't listed (its connect didn't name this workspace): type the code it
 * shows. Enter adds it; the field clears and keeps focus for the next.
 */
function ManualCode({ workspace, onAdded }: { readonly workspace: Relay.Workspace; readonly onAdded: () => void }) {
	const input = useRef<HTMLInputElement>(null);
	const approve = useAtomSet(approveAtom, { mode: "promise" });
	const [open, setOpen] = useState(false);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [added, setAdded] = useState<string | null>(null);
	const submit = () => {
		if (busy) return;
		if (code.trim() === "") {
			setError("Enter the code the machine shows.");
			return;
		}
		setBusy(true);
		setError(null);
		approve({ userCode: code.trim().toUpperCase(), workspaceId: workspace.id })
			.then(({ machine }) => {
				setAdded(machine.givenName ?? machine.localHostName);
				setCode("");
				onAdded();
			})
			.catch((cause: unknown) => setError(relayFailure(cause)))
			.finally(() => {
				setBusy(false);
				input.current?.focus();
			});
	};
	return (
		<div className="flex flex-col gap-2">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((shown) => !shown)}
				className="relative flex w-fit items-center gap-1 rounded-md text-xs text-ink-muted outline-none before:absolute before:-inset-x-2 before:-inset-y-2.5 before:content-[''] hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
			>
				<CaretRightIcon
					size={10}
					weight="bold"
					className={`transition-transform duration-150 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
					aria-hidden
				/>
				Enter a Code Instead
			</button>
			<Collapse open={open} onOpened={() => input.current?.focus({ preventScroll: true })}>
				<form
					className="flex items-start gap-2 pt-2"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<div className="flex min-w-0 flex-1 flex-col gap-1.5">
						<Input
							ref={input}
							value={code}
							placeholder="ABCD-EFGH"
							aria-label="Code from codework connect"
							aria-invalid={error !== null}
							autoComplete="off"
							spellCheck={false}
							className="font-mono tracking-widest uppercase"
							readOnly={busy}
							onChange={(event) => {
								setCode(event.target.value);
								setError(null);
							}}
						/>
						{error !== null && <p className="text-xs text-destructive">{error}</p>}
						{added !== null && error === null && <Done key={added}>Approved {added}</Done>}
					</div>
					<Button type="submit" size="sm" className="min-w-20" disabled={busy}>
						{busy ? "Adding…" : "Add"}
					</Button>
				</form>
			</Collapse>
		</div>
	);
}
