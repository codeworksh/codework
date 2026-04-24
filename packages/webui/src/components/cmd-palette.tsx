import { useNavigate } from "@tanstack/react-router";
import { HomeIcon, LayersIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, type ComponentType, type ReactNode } from "react";

import { useCommandPaletteStore } from "../lib/cmd-palette-store";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from "./ui/command";

interface CommandPaletteAction {
	icon: ComponentType<{ className?: string }>;
	keywords: string;
	label: string;
	run: () => void;
	shortcut?: string;
	value: string;
}

export function CommandPalette({ children }: { children: ReactNode }) {
	const navigate = useNavigate();
	const open = useCommandPaletteStore((store) => store.open);
	const setOpen = useCommandPaletteStore((store) => store.setOpen);
	const toggleOpen = useCommandPaletteStore((store) => store.toggleOpen);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) {
				return;
			}

			event.preventDefault();
			toggleOpen();
		};

		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [toggleOpen]);

	const actions: CommandPaletteAction[] = [
		{
			icon: HomeIcon,
			keywords: "home dashboard start",
			label: "Go home",
			run: () => void navigate({ to: "/" }),
			shortcut: "G H",
			value: "go-home",
		},
		{
			icon: LayersIcon,
			keywords: "concepts architecture desktop renderer bridge",
			label: "Open concepts",
			run: () => void navigate({ to: "/concepts" }),
			shortcut: "G C",
			value: "open-concepts",
		},
		{
			icon: RotateCcwIcon,
			keywords: "reload refresh restart",
			label: "Reload app",
			run: () => window.location.reload(),
			shortcut: "R",
			value: "reload-app",
		},
	];

	function execute(action: CommandPaletteAction): void {
		setOpen(false);
		action.run();
	}

	return (
		<>
			{children}
			<CommandDialog
				className="max-w-[calc(100vw-2rem)] sm:max-w-xl"
				description="Search routes and app commands"
				onOpenChange={setOpen}
				open={open}
				title="Command Palette"
			>
				<Command shouldFilter>
					<CommandInput autoFocus placeholder="Search commands..." />
					<CommandList>
						<CommandEmpty>No commands found.</CommandEmpty>
						<CommandGroup heading="Navigation">
							{actions.map((action) => (
								<CommandItem
									key={action.value}
									keywords={action.keywords.split(" ")}
									onSelect={() => execute(action)}
									value={`${action.value} ${action.label}`}
								>
									<action.icon className="size-3.5" />
									<span>{action.label}</span>
									{action.shortcut ? <CommandShortcut>{action.shortcut}</CommandShortcut> : null}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</CommandDialog>
		</>
	);
}
