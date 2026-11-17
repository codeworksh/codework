import { useClerk } from "@clerk/electron/react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { CaretDownIcon, CheckIcon, PlusIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";

import { Monogram } from "@/components/monogram";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isSignedInApp } from "../auth";
import { chooseWorkspaceAtom, meAtom, workspaceAtom } from "../kernel/relay";

/**
 * The workspace menu at the top of the sidebar: settings, members, switching workspaces and signing out.
 * It stays while the relay is unreachable, as CodeWork, since it is also the way to settings.
 */
export function WorkspaceSwitcher() {
	const navigate = useNavigate();
	const current = useAtomValue(workspaceAtom);
	const workspace = AsyncResult.isSuccess(current) ? current.value : undefined;
	const id = workspace?.id ?? "codework";
	const name = workspace?.name ?? "CodeWork";
	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="flex h-8 max-w-full items-center gap-2 self-start rounded-md px-1.5 text-left text-ui text-ink outline-none transition-colors duration-150 ease-out hover:bg-selection-subtle focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=open]:bg-selection-subtle data-[state=open]:duration-0">
				<Monogram id={id} name={name} />
				<span className="min-w-0 truncate font-medium">{name}</span>
				<CaretDownIcon size={11} className="shrink-0 text-ink-muted" aria-hidden />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				<DropdownMenuItem onSelect={() => void navigate({ to: "/settings" })}>Settings</DropdownMenuItem>
				{isSignedInApp && (
					<>
						{/* Members come with invites; the row marks where they will live. */}
						<DropdownMenuItem disabled>Invite & Manage Members</DropdownMenuItem>
						<DropdownMenuSeparator />
						<SwitchWorkspace current={workspace?.id} />
						<SignOut />
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The account's workspaces in a submenu, the current one checked, and creating another. */
function SwitchWorkspace({ current }: { readonly current: string | undefined }) {
	const navigate = useNavigate();
	const me = useAtomValue(meAtom);
	const choose = useAtomSet(chooseWorkspaceAtom);
	if (!AsyncResult.isSuccess(me)) {
		return <DropdownMenuItem disabled>Switch Workspace</DropdownMenuItem>;
	}
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>Switch Workspace</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="w-56">
				<DropdownMenuLabel className="truncate">{me.value.account.email}</DropdownMenuLabel>
				{me.value.workspaces.map((option) => (
					<DropdownMenuItem key={option.id} onSelect={() => choose(option.id)}>
						<Monogram id={option.id} name={option.name} />
						<span className="min-w-0 flex-1 truncate">{option.name}</span>
						{option.id === current && <CheckIcon size={13} className="shrink-0" aria-hidden />}
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => void navigate({ to: "/workspaces/join" })}>
					<PlusIcon size={15} aria-hidden />
					Create Workspace
				</DropdownMenuItem>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

function SignOut() {
	const clerk = useClerk();
	return <DropdownMenuItem onSelect={() => void clerk.signOut()}>Sign Out</DropdownMenuItem>;
}
