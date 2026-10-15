import { useNavigate } from "@tanstack/react-router";
import { ArrowUp } from "lucide-react";
import { useState } from "react";

import { useWorkspaces, workspaceRoute } from "../wm/workspaces";
import { Wordmark } from "./wordmark";

/** The start page: pick a project to work in. */
export function Landing() {
	const workspaces = useWorkspaces();
	const navigate = useNavigate();
	const [query, setQuery] = useState("");

	// Projects have no workspace of their own yet, so every one opens the default workspace.
	const target = workspaces[0];
	const canOpen = target !== undefined && query.trim() !== "";

	return (
		<div className="flex h-full flex-col select-none">
			{/* The window's drag region, clear of the macOS traffic lights. */}
			<header className="h-11 shrink-0 [-webkit-app-region:drag]" />
			<main className="relative flex min-h-0 flex-1 flex-col items-center overflow-auto px-4">
				<div className="flex-[0.8]" />
				<Wordmark className="pointer-events-none w-[min(88%,44rem)] shrink-0 text-brand opacity-15" />
				<form
					className="panel mt-10 flex w-full max-w-xl shrink-0 flex-col p-1.5 transition-colors focus-within:border-edge-focus"
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
						className="h-10 bg-transparent px-2.5 text-[14px] text-ink outline-none placeholder:text-ink-muted"
					/>
					<div className="flex justify-end">
						<button
							type="submit"
							aria-label="Open project"
							disabled={!canOpen}
							className="grid size-7 place-items-center bg-brand text-brand-ink transition-opacity disabled:opacity-30"
						>
							<ArrowUp className="size-4" strokeWidth={2} aria-hidden />
						</button>
					</div>
				</form>
				<div className="flex-1" />
			</main>
		</div>
	);
}
