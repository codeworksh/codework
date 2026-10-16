import { useAtom } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronRight, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { isTheme, previewTheme, THEMES, themeAtom } from "../theme";
import { paletteShortcut } from "./switcher";
import { Swatch } from "./swatch";

/** How long the highlight rests on a theme before it previews, so scrolling through doesn't strobe. */
const PREVIEW_DELAY = 200;

const THEME_SETTINGS = "settings:themes";

/**
 * The Cmd+K command palette. Moving through the theme list with the keyboard previews each theme;
 * Enter keeps the highlighted one and closing without choosing restores the saved one. The pointer
 * only picks: hovering neither moves the highlight nor previews.
 */
export function Palette() {
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [saved, setTheme] = useAtom(themeAtom);
	// The highlighted item, controlled so each opening starts at the top.
	const [value, setValue] = useState(THEME_SETTINGS);
	const pending = useRef<ReturnType<typeof setTimeout>>(undefined);

	const show = (next: boolean) => {
		clearTimeout(pending.current);
		if (next) {
			setValue(THEME_SETTINGS);
		} else {
			previewTheme(saved);
		}
		setOpen(next);
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!paletteShortcut(event)) return;
			event.preventDefault();
			show(!open);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	const run = (action: () => void) => {
		clearTimeout(pending.current);
		action();
		setOpen(false);
	};

	return (
		<CommandDialog
			open={open}
			onOpenChange={show}
			showCloseButton={false}
			className="top-[20%] translate-y-0 sm:max-w-xl"
			command={{
				value,
				disablePointerSelection: true,
				onValueChange: (next) => {
					setValue(next);
					clearTimeout(pending.current);
					// Leaving the theme list restores the saved theme.
					const shown = isTheme(next) ? next : saved;
					pending.current = setTimeout(() => previewTheme(shown), PREVIEW_DELAY);
				},
			}}
		>
			<CommandInput placeholder="Type a command or search…" />
			<CommandList className="max-h-[min(420px,60vh)]">
				<CommandEmpty>No results.</CommandEmpty>
				<CommandGroup heading="Settings">
					<CommandItem
						value={THEME_SETTINGS}
						keywords={["change theme", "appearance", "colors"]}
						onSelect={() => run(() => void navigate({ to: "/settings/themes" }))}
						className="hover:bg-accent/50"
					>
						<Settings strokeWidth={1.75} />
						Change theme…
					</CommandItem>
					{THEMES.map((theme) => (
						<CommandItem
							key={theme.id}
							value={theme.id}
							keywords={["change theme", theme.name]}
							onSelect={() => run(() => setTheme(theme.id))}
							className="hover:bg-accent/50"
						>
							<Swatch theme={theme.id} />
							<span className="text-ink-muted">Change theme</span>
							<ChevronRight className="-mx-1 size-3.5! text-ink-muted" strokeWidth={1.75} aria-hidden />
							{theme.name}
							{theme.id === saved && <Check className="ml-auto text-ink-muted" aria-label="Current theme" />}
						</CommandItem>
					))}
				</CommandGroup>
			</CommandList>
		</CommandDialog>
	);
}
