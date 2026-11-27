import { useClerk } from "@clerk/electron/react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { CaretDownIcon, SignOutIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Frame } from "./frame";
import { createWorkspaceAtom, meAtom, relayFailure } from "./kernel/relay";

/** Creates a workspace: a name, then Create Workspace. Full window, outside the app's sidebar. */
export function Join() {
	const navigate = useNavigate();
	const create = useAtomSet(createWorkspaceAtom, { mode: "promise" });
	const [name, setName] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const trimmed = name.trim();
	return (
		<Frame end={<Account />}>
			{/* Extra room below lifts the form a little above center, where it reads as centered. */}
			<main className="flex flex-1 flex-col items-center overflow-auto px-4 pb-24">
				<form
					className="my-auto flex w-full max-w-sm flex-col gap-10"
					onSubmit={(event) => {
						event.preventDefault();
						if (pending) return;
						// Checked on submit, not while typing; the error clears on the next keystroke.
						if (trimmed === "") {
							setError("Enter a name.");
							return;
						}
						setPending(true);
						setError(null);
						create(trimmed)
							.then(() =>
								navigate({
									to: "/settings/machines/setup",
									// The form is done; Back from setup shouldn't land on it again.
									replace: true,
								}),
							)
							.catch((cause: unknown) => {
								setError(relayFailure(cause));
								setPending(false);
							});
					}}
				>
					<div className="flex flex-col items-center gap-2 text-center">
						<h1 className="text-xl font-semibold tracking-tight text-balance">Create a Workspace</h1>
						<p className="text-ui text-ink-muted text-balance">Start a Workspace for your Team &amp; Projects</p>
					</div>
					<div className="flex flex-col gap-6">
						<div className="flex flex-col gap-2">
							<label htmlFor="workspace-name" className="text-xs font-medium text-ink-secondary">
								Name
							</label>
							<Input
								id="workspace-name"
								size="lg"
								value={name}
								onChange={(event) => {
									setName(event.target.value);
									setError(null);
								}}
								maxLength={64}
								autoComplete="off"
								spellCheck={false}
								data-1p-ignore
								data-lpignore="true"
								aria-invalid={error !== null}
								aria-describedby={error === null ? undefined : "workspace-error"}
								// oxlint-disable-next-line jsx-a11y/no-autofocus -- the page's only field
								autoFocus
								// Read-only, not disabled, so the field keeps focus while it saves and after a failure.
								readOnly={pending}
							/>
							{error !== null && (
								<p id="workspace-error" role="alert" className="text-xs text-destructive">
									{error}
								</p>
							)}
						</div>
						<Button type="submit" size="lg" disabled={pending}>
							{pending ? "Creating…" : "Create Workspace"}
						</Button>
					</div>
				</form>
			</main>
		</Frame>
	);
}

/** The signed-in email, with Sign Out. */
function Account() {
	const me = useAtomValue(meAtom);
	const clerk = useClerk();
	if (!AsyncResult.isSuccess(me)) return null;
	const { email } = me.value.account;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="flex h-7 max-w-64 items-center gap-1.5 rounded-md px-2 text-2xs text-ink-muted outline-none [-webkit-app-region:no-drag] hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-selection-subtle">
				<span className="truncate">{email}</span>
				<CaretDownIcon size={11} className="shrink-0" aria-hidden />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				<DropdownMenuLabel className="truncate">{email}</DropdownMenuLabel>
				<DropdownMenuItem onSelect={() => void clerk.signOut()}>
					<SignOutIcon size={15} aria-hidden />
					Sign Out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
