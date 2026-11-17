import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { CaretUpDownIcon, CheckIcon, DesktopTowerIcon, KeyIcon } from "@phosphor-icons/react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Monogram } from "@/components/monogram";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { chooseWorkspaceAtom, meAtom, workspaceAtom } from "../kernel/relay";
import { ApproveDialog, ConnectDialog, machineAtom } from "./connect";

/**
 * The workspace the app works in, a menu of the account's others, and connecting machines to it. Absent
 * until the relay answers.
 */
export function WorkspaceSwitcher() {
	const me = useAtomValue(meAtom);
	const current = useAtomValue(workspaceAtom);
	const choose = useAtomSet(chooseWorkspaceAtom);
	const machine = useAtomValue(machineAtom);
	const [dialog, setDialog] = useState<"connect" | "approve" | null>(null);
	if (!AsyncResult.isSuccess(me) || !AsyncResult.isSuccess(current) || current.value === undefined) return null;
	const workspace = current.value;
	// Unknown while the local server is unreachable; connecting then fails in the dialog and says so.
	const linked =
		AsyncResult.isSuccess(machine) && machine.value.workspaces.some((option) => option.id === workspace.id);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger className="flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-ui text-ink outline-none hover:bg-selection-subtle focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=open]:bg-selection-subtle">
					<Monogram id={workspace.id} name={workspace.name} />
					<span className="min-w-0 flex-1 truncate font-medium">{workspace.name}</span>
					<CaretUpDownIcon size={13} className="shrink-0 text-ink-muted" aria-hidden />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-64">
					<DropdownMenuLabel className="truncate">{me.value.account.email}</DropdownMenuLabel>
					{me.value.workspaces.map((option) => (
						<DropdownMenuItem key={option.id} onSelect={() => choose(option.id)}>
							<Monogram id={option.id} name={option.name} />
							<span className="min-w-0 flex-1 truncate">{option.name}</span>
							{option.id === workspace.id && <CheckIcon size={13} className="shrink-0" aria-hidden />}
						</DropdownMenuItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuItem disabled={linked} onSelect={() => setDialog("connect")}>
						<DesktopTowerIcon size={15} aria-hidden />
						{linked ? "This Machine Is Connected" : "Connect This Machine"}
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => setDialog("approve")}>
						<KeyIcon size={15} aria-hidden />
						Approve a Machine…
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{dialog === "connect" && <ConnectDialog workspace={workspace} onClose={() => setDialog(null)} />}
			{dialog === "approve" && <ApproveDialog workspace={workspace} onClose={() => setDialog(null)} />}
		</>
	);
}
