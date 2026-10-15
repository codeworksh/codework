import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, Check, ChevronDown, Folder, FolderPlus, MemoryStick } from "lucide-react";
import { type CSSProperties, useState } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useWorkspaces, workspaceRoute } from "../wm/workspaces";
import { SessionsSidebar, TitleBar } from "./sidebar";
import { Wordmark } from "./wordmark";

const bridge = window.desktopBridge;

/** Where a new project lives: nowhere yet, only in memory, or a folder on disk. */
type Place = { kind: "none" } | { kind: "memory" } | { kind: "folder"; path: string };

// A folder shows by its name alone; the trigger's tooltip carries the full path.
const placeLabel = (place: Place) =>
	place.kind === "none"
		? "Select Project"
		: place.kind === "memory"
			? "In Memory"
			: (place.path.split("/").findLast(Boolean) ?? place.path);

/** The start page: pick a project to work in. */
export function Landing() {
	const workspaces = useWorkspaces();
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const [place, setPlace] = useState<Place>({ kind: "none" });

	// Projects have no workspace of their own yet, so every one opens the default workspace.
	const target = workspaces[0];
	const canOpen = target !== undefined && query.trim() !== "";

	// Only the desktop app can open the native folder dialog (Finder on macOS); it opens on the
	// current folder, or home before one is picked.
	const pickFolder =
		bridge === undefined
			? undefined
			: async () => {
					const picked = await bridge.pickFolder(place.kind === "folder" ? place.path : bridge.home);
					if (picked !== null) setPlace({ kind: "folder", path: picked });
				};
	const PlaceIcon = place.kind === "memory" ? MemoryStick : Folder;

	return (
		<SidebarProvider
			className="h-full min-h-0"
			style={{ "--sidebar-width": "17rem" } as CSSProperties}
			widthStorageKey="codework.sidebar.width"
		>
			<SessionsSidebar />
			<div className="flex min-w-0 flex-1 flex-col select-none">
				<TitleBar />
				<main className="relative flex min-h-0 flex-1 flex-col items-center overflow-auto px-4">
					<div className="flex-[0.8]" />
					<Wordmark className="pointer-events-none w-[min(88%,44rem)] shrink-0 text-brand opacity-15" />
					<div className="mt-10 w-full max-w-2xl shrink-0">
						<form
							className="relative z-10 flex flex-col rounded-[22px] border border-edge bg-frame shadow-[0_12px_28px_-18px_rgb(0_0_0/0.4)] transition-colors focus-within:border-edge-focus"
							onSubmit={(event) => {
								event.preventDefault();
								if (canOpen) void navigate(workspaceRoute(target));
							}}
						>
							<div className="px-4 pt-4 pb-2">
								<textarea
									autoFocus
									rows={1}
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									onKeyDown={(event) => {
										// Enter sends and Shift+Enter breaks the line; an IME composition owns its own Enter.
										if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
										event.preventDefault();
										event.currentTarget.form?.requestSubmit();
									}}
									placeholder="Ask for changes, send follow-ups, or attach images"
									aria-label="Prompt"
									// Grows with its text from four lines up to about nine, then scrolls.
									className="block max-h-52 min-h-17.5 w-full resize-none bg-transparent text-[14px] leading-relaxed text-ink outline-none [field-sizing:content] placeholder:text-ink-muted/60"
								/>
							</div>
							<div className="flex items-center justify-end gap-2 px-4 pb-4">
								<button
									type="submit"
									aria-label="Send"
									disabled={!canOpen}
									className="grid size-8 place-items-center rounded-full bg-brand text-brand-ink shadow-xs transition-[opacity,scale] duration-150 enabled:hover:scale-105 disabled:opacity-30"
								>
									<ArrowUp className="size-4" strokeWidth={2} aria-hidden />
								</button>
							</div>
						</form>
						{/* A tray tucked under the composer, inset from its rounded corners. */}
						<div className="mx-5.5 -mt-4 flex items-center rounded-b-[16px] border border-edge bg-frame/60 px-2 pt-5 pb-1 text-[12px] text-ink-muted/70">
							<DropdownMenu>
								<DropdownMenuTrigger
									title={place.kind === "folder" ? place.path : undefined}
									className="flex h-6 min-w-0 items-center gap-1 rounded-[8px] px-1.75 leading-4 outline-none transition-colors hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5 data-[state=open]:bg-ink/5 data-[state=open]:text-ink"
								>
									<PlaceIcon className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
									<span className="truncate">{placeLabel(place)}</span>
									<ChevronDown className="size-3 shrink-0 opacity-50" strokeWidth={2} aria-hidden />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="min-w-44">
									<DropdownMenuLabel>Project</DropdownMenuLabel>
									<DropdownMenuItem onSelect={() => setPlace({ kind: "memory" })}>
										<MemoryStick strokeWidth={1.75} />
										In Memory
										{place.kind === "memory" && (
											<Check className="ml-auto" strokeWidth={2} aria-label="Current" />
										)}
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem disabled={pickFolder === undefined} onSelect={() => void pickFolder?.()}>
										<FolderPlus strokeWidth={1.75} />
										New…
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					</div>
					<div className="flex-1" />
				</main>
			</div>
		</SidebarProvider>
	);
}
