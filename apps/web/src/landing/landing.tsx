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

const placeLabel = (place: Place) =>
	place.kind === "none" ? "No project" : place.kind === "memory" ? "In Memory" : shorten(tildify(place.path));

/** A path under the home directory as `~/…`, the way a shell prompt shows it. */
const tildify = (path: string) => {
	const home = bridge?.home;
	return home !== undefined && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
};

const MAX_PATH = 40;

/**
 * Fits a path in MAX_PATH characters by eliding its middle: the root folder stays, then as many
 * trailing folders as fit, e.g. `~/…/apps/web`. A single overlong name is cut mid-name instead.
 */
function shorten(path: string) {
	if (path.length <= MAX_PATH) return path;
	const parts = path.split("/");
	// `~/a/b` keeps `~`; `/Users/a/b` keeps `/Users`.
	const rootEnd = parts[0] === "" ? 1 : 0;
	const root = parts.slice(0, rootEnd + 1).join("/");
	let tail = parts.at(-1) ?? "";
	for (let index = parts.length - 2; index > rootEnd; index--) {
		const longer = `${parts[index]}/${tail}`;
		if (root.length + longer.length + 3 > MAX_PATH) break;
		tail = longer;
	}
	const short = `${root}/…/${tail}`;
	if (short.length <= MAX_PATH) return short;
	const half = Math.floor((MAX_PATH - 1) / 2);
	return `${path.slice(0, half)}…${path.slice(-half)}`;
}

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
							className="relative z-10 flex flex-col gap-2 rounded-[24px] border border-edge bg-frame p-3 transition-colors focus-within:border-edge-focus"
							onSubmit={(event) => {
								event.preventDefault();
								if (canOpen) void navigate(workspaceRoute(target));
							}}
						>
							<input
								autoFocus
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Open a project…"
								aria-label="Project"
								className="h-10 bg-transparent px-2 text-[14px] text-ink outline-none placeholder:text-ink-muted"
							/>
							<div className="flex justify-end">
								<button
									type="submit"
									aria-label="Open project"
									disabled={!canOpen}
									className="grid size-8 place-items-center rounded-full bg-brand text-brand-ink transition-opacity disabled:opacity-30"
								>
									<ArrowUp className="size-4" strokeWidth={2} aria-hidden />
								</button>
							</div>
						</form>
						{/* A tray tucked under the composer, inset from its rounded corners. */}
						<div className="mx-5.5 -mt-4 flex items-center rounded-b-[16px] border border-edge bg-frame/60 px-1.5 pt-5 pb-1 text-[12px] text-ink-muted">
							<DropdownMenu>
								<DropdownMenuTrigger
									title={place.kind === "folder" ? place.path : undefined}
									className="flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 outline-none transition-colors hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5 data-[state=open]:bg-ink/5 data-[state=open]:text-ink"
								>
									<PlaceIcon className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
									<span className="truncate">{placeLabel(place)}</span>
									<ChevronDown className="size-3 shrink-0 opacity-60" strokeWidth={2} aria-hidden />
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
