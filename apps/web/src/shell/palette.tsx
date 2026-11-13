import {
	CaretRightIcon,
	ChatsIcon,
	CheckIcon,
	FolderPlusIcon,
	GearSixIcon,
	TreeStructureIcon,
} from "@phosphor-icons/react";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { isTheme, previewTheme, THEMES, themeAtom } from "../theme";
import { AddProject, PALETTE_LIST, type View } from "./sources";
import { paletteShortcut } from "./switcher";
import { Swatch } from "./swatch";

const GO_PROJECTS = "navigation:projects";
const GO_THREADS = "navigation:threads";
const ADD_PROJECT = "projects:add";
const THEME_SETTINGS = "settings:themes";

/** Whether the palette is open, and the steps opened past its root list, each with what was typed. */
const paletteAtom = Atom.make<{ open: boolean; stack: ReadonlyArray<{ view: View; query: string }> }>({
	open: false,
	stack: [],
}).pipe(Atom.keepAlive);

/** Opens the palette at Add Project's sources. */
export function useAddProject() {
	const setPalette = useAtomSet(paletteAtom);
	return () => setPalette({ open: true, stack: [{ view: { kind: "sources" }, query: "" }] });
}

/**
 * The Cmd+K command palette. Highlighting a theme with the keyboard previews it;
 * Enter keeps the highlighted one and closing without choosing restores the saved one. The pointer
 * only picks: hovering neither moves the highlight nor previews.
 */
export function Palette() {
	const navigate = useNavigate();
	const [{ open, stack }, setPalette] = useAtom(paletteAtom);
	const step = stack.at(-1);
	const [saved, setTheme] = useAtom(themeAtom);
	// The highlighted item, controlled so each opening starts at the top.
	const [value, setValue] = useState(GO_THREADS);

	const show = (next: boolean) => {
		if (next) {
			setValue(GO_THREADS);
		} else {
			previewTheme(saved);
		}
		setPalette({ open: next, stack: [] });
	};
	const close = () => show(false);

	const push = (view: View, query = "") => {
		setValue("");
		setPalette({ open, stack: [...stack, { view, query }] });
	};
	const pop = () => {
		setValue(stack.length === 1 ? ADD_PROJECT : "");
		setPalette({ open, stack: stack.slice(0, -1) });
	};
	const setQuery = (query: string) =>
		setPalette({
			open,
			stack: stack.map((entry, index) => (index === stack.length - 1 ? { ...entry, query } : entry)),
		});

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!paletteShortcut(event)) return;
			event.preventDefault();
			show(!open);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	// Closes without putting the saved theme back: the action may have just chosen another.
	const run = (action: () => void) => {
		setPalette({ open: false, stack: [] });
		action();
	};

	return (
		<CommandDialog
			open={open}
			onOpenChange={show}
			showCloseButton={false}
			// No open/close animation: it is keyboard-opened and used many times a day. One height for
			// every step and listing, so moving through them never resizes it.
			className="top-[20%] flex h-[min(440px,70vh)] translate-y-0 flex-col data-[state=closed]:animate-none! data-[state=open]:animate-none! sm:max-w-xl"
			command={{
				value,
				disablePointerSelection: true,
				// Typed paths, names and URLs aren't searches; the steps filter their own rows.
				shouldFilter: step === undefined || step.view.kind === "sources",
				onValueChange: (next) => {
					setValue(next);
					// A theme previews as soon as it is highlighted; leaving the list restores the saved one.
					previewTheme(isTheme(next) ? next : saved);
				},
			}}
		>
			{step !== undefined ? (
				<AddProject key={stack.length} step={step} setQuery={setQuery} push={push} pop={pop} close={close} />
			) : (
				<>
					<CommandInput placeholder="Type a command or search…" />
					<CommandList className={PALETTE_LIST}>
						<CommandEmpty>No Results</CommandEmpty>
						<CommandGroup heading="Navigation">
							<CommandItem
								value={GO_THREADS}
								keywords={["all threads", "go", "issues", "list", "status", "priority", "groups"]}
								onSelect={() => run(() => void navigate({ to: "/threads" }))}
							>
								<ChatsIcon />
								Threads
							</CommandItem>
							<CommandItem
								value={GO_PROJECTS}
								keywords={["projects", "go", "sessions", "forks", "tree"]}
								onSelect={() => run(() => void navigate({ to: "/projects" }))}
							>
								<TreeStructureIcon />
								Projects
							</CommandItem>
						</CommandGroup>
						<CommandGroup heading="Projects">
							<CommandItem
								value={ADD_PROJECT}
								keywords={[
									"add project",
									"new project",
									"folder",
									"directory",
									"browse",
									"clone",
									"repository",
									"github",
								]}
								onSelect={() => push({ kind: "sources" })}
							>
								<FolderPlusIcon />
								Add Project…
							</CommandItem>
						</CommandGroup>
						<CommandGroup heading="Settings">
							<CommandItem
								value={THEME_SETTINGS}
								keywords={["change theme", "appearance", "colors"]}
								onSelect={() => run(() => void navigate({ to: "/settings/themes" }))}
							>
								<GearSixIcon />
								Change theme…
							</CommandItem>
							{THEMES.map((theme) => (
								<CommandItem
									key={theme.id}
									value={theme.id}
									keywords={["change theme", theme.name]}
									onSelect={() => run(() => setTheme(theme.id))}
								>
									<Swatch theme={theme.id} />
									<span className="text-ink-muted">Change theme</span>
									<CaretRightIcon className="-mx-1 size-3.5! text-ink-muted" aria-hidden />
									{theme.name}
									{theme.id === saved && (
										<CheckIcon className="ml-auto text-ink-muted" aria-label="Current theme" />
									)}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</>
			)}
		</CommandDialog>
	);
}
