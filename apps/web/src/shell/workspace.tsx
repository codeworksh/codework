import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { CaretUpDownIcon, CheckIcon } from "@phosphor-icons/react";
import { AsyncResult } from "effect/reactivity";

import { Monogram } from "@/components/monogram";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { chooseWorkspaceAtom, meAtom, workspaceAtom } from "../kernel/relay";

/** The workspace the app works in, and a menu of the account's others. Absent until the relay answers. */
export function WorkspaceSwitcher() {
	const me = useAtomValue(meAtom);
	const current = useAtomValue(workspaceAtom);
	const choose = useAtomSet(chooseWorkspaceAtom);
	if (!AsyncResult.isSuccess(me) || !AsyncResult.isSuccess(current) || current.value === undefined) return null;
	const workspace = current.value;
	return (
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
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
