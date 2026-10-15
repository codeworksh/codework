import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Search } from "lucide-react";
import { type CSSProperties, useState } from "react";

import {
	Sidebar,
	SidebarContent,
	SidebarHeader,
	SidebarInput,
	SidebarRail,
	SidebarTrigger,
	useSidebar,
} from "@/components/ui/sidebar";
import { isMac } from "../kernel/platform";
import { Server } from "../kernel/rpc";
import { ago } from "../widgets/projects/time";

const projectsAtom = Server.query("projects.list", undefined);

// macOS draws its traffic lights over the window's top-left corner, which the sidebar now owns.
const insetTitleBar = window.desktopBridge?.platform === "darwin";

/** Badge colours, light-theme ink then dark-theme ink; light-dark() follows the theme's color-scheme. */
const INKS = [
	["#dc2626", "#f87171"],
	["#ea580c", "#fb923c"],
	["#d97706", "#fbbf24"],
	["#65a30d", "#a3e635"],
	["#059669", "#34d399"],
	["#0d9488", "#2dd4bf"],
	["#0284c7", "#38bdf8"],
	["#2563eb", "#60a5fa"],
	["#7c3aed", "#a78bfa"],
	["#db2777", "#f472b6"],
] as const;

/** The same project always gets the same colour, without storing one. */
function inkOf(id: string) {
	let hash = 0;
	for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	const [light, dark] = INKS[Math.abs(hash) % INKS.length]!;
	return `light-dark(${light}, ${dark})`;
}

/** Two letters: the first and last word's initials (`codework-prompt-musk` → CM), else a word's first and last letter. */
function monogram(name: string) {
	const words = name.split(/[\s._-]+/).filter(Boolean);
	const first = words[0] ?? "?";
	const last = words.at(-1) ?? first;
	return (words.length > 1 ? `${first[0]}${last[0]}` : `${first[0]}${first.at(-1) ?? ""}`).toUpperCase();
}

function Monogram({ id, name }: { id: string; name: string }) {
	return (
		<span
			aria-hidden
			style={{ color: inkOf(id) } as CSSProperties}
			className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-[color-mix(in_oklab,currentColor_14%,transparent)] font-mono text-[8px] font-bold"
		>
			{monogram(name)}
		</span>
	);
}

/** Recent sessions across every project, newest first. */
export function SessionsSidebar() {
	const result = useAtomValue(projectsAtom);
	const [query, setQuery] = useState("");

	const needle = query.trim().toLowerCase();
	const sessions = AsyncResult.isSuccess(result)
		? result.value
				.flatMap((project) => project.sessions.map((session) => ({ ...session, project })))
				.filter(({ title, project }) => `${title} ${project.name}`.toLowerCase().includes(needle))
				.sort((a, b) => b.updated - a.updated)
		: [];

	return (
		<Sidebar collapsible="offcanvas" className="select-none">
			<SidebarHeader className="gap-0 p-0">
				{/* The window's drag region, clear of the macOS traffic lights. */}
				<div className={`h-11 shrink-0 [-webkit-app-region:drag] ${insetTitleBar ? "pl-20" : ""}`} />
				<div className="relative px-2 pb-2">
					<Search className="pointer-events-none absolute top-1/2 left-4.5 size-3.5 -translate-y-1/2 text-ink-muted" />
					<SidebarInput
						type="search"
						placeholder="Search"
						aria-label="Search sessions"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						className="h-8 rounded-[8px] border-transparent bg-transparent pl-8 text-[13px] shadow-none focus-visible:bg-ink/5"
					/>
				</div>
			</SidebarHeader>
			<SidebarContent className="px-2 pb-2">
				{AsyncResult.isFailure(result) ? (
					<p className="px-2.5 py-2 text-[12px] text-ink-muted">
						{Option.match(AsyncResult.error(result), {
							// Says how to start the CodeWork server when that is the reason.
							onSome: (error) =>
								error._tag === "Server.CodeworkUnavailable" ? error.message : "Could not load sessions.",
							onNone: () => "Could not load sessions.",
						})}
					</p>
				) : AsyncResult.isSuccess(result) && sessions.length === 0 ? (
					<p className="px-2.5 py-2 text-[12px] text-ink-muted">
						{needle === "" ? "No sessions yet." : `No sessions match “${query}”.`}
					</p>
				) : (
					<ul className="flex flex-col gap-0.5">
						{sessions.map((session) => (
							<li
								key={session.id}
								className="rounded-[8px] px-2.5 py-2 transition-colors hover:bg-ink/5"
								title={session.project.path}
							>
								<div className="flex h-5 min-w-0 items-center gap-1.5 text-[12px] text-ink-muted">
									<Monogram id={session.project.id} name={session.project.name} />
									<span className="min-w-0 flex-1 truncate">{session.project.name}</span>
									<span className="shrink-0 tabular-nums">{ago(session.updated)}</span>
								</div>
								<div className="mt-1 truncate text-[13px] text-ink">{session.title}</div>
								{session.model !== undefined && (
									<div className="mt-0.5 truncate text-[11px] text-ink-muted/60">{session.model.id}</div>
								)}
							</li>
						))}
					</ul>
				)}
			</SidebarContent>
			<SidebarRail />
		</Sidebar>
	);
}

/**
 * The main area's title bar: the window's drag region with the sidebar toggle. With the sidebar
 * hidden it sits in the window's corner, so it moves clear of the macOS traffic lights.
 */
export function TitleBar() {
	const { open } = useSidebar();
	return (
		<header
			className={`flex h-11 shrink-0 items-center px-2 [-webkit-app-region:drag] ${!open && insetTitleBar ? "pl-20" : ""}`}
		>
			<SidebarTrigger
				title={`Toggle sidebar (${isMac ? "⌘B" : "Ctrl+B"})`}
				className="text-ink-muted [-webkit-app-region:no-drag] hover:text-ink"
			/>
		</header>
	);
}
