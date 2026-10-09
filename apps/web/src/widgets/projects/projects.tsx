import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Folder } from "lucide-react";
import type { MouseEvent } from "react";

import { isMac, openMode, Server, useShell } from "../../sdk";
import { sessionAddress } from "./address";
import { ago } from "./time";

const list = Server.query("projects.list", undefined);

export function Projects() {
	const shell = useShell();
	const result = useAtomValue(list);
	// Primary and middle clicks open; a right click is left to the context menu.
	const open = (id: string, event: MouseEvent) => {
		if (event.button <= 1) shell.open(sessionAddress(id), { mode: openMode(event) });
	};

	return AsyncResult.match(result, {
		onInitial: () => null,
		onFailure: () => <p className="p-3 text-ink-muted">Could not load projects.</p>,
		onSuccess: ({ value: projects }) => (
			<ul className="h-full overflow-auto px-1.5 pb-2">
				{projects.map((project) => (
					<li key={project.id} className="mb-2">
						<div className="flex items-center gap-1.5 px-1.5 py-1" title={project.path}>
							<Folder className="size-3.5 shrink-0 text-ink-muted" strokeWidth={1.75} aria-hidden />
							<span className="truncate font-medium">{project.name}</span>
						</div>
						<ul>
							{project.sessions.map((session) => (
								<li key={session.id}>
									<button
										type="button"
										data-session={session.id}
										title={`Open session (${isMac ? "⌘" : "Ctrl"}-click or middle-click opens a new one)`}
										className="flex w-full items-baseline gap-2 rounded-md py-1 pr-1.5 pl-6.5 text-left hover:bg-ink/5"
										onClick={(event) => open(session.id, event)}
										onAuxClick={(event) => open(session.id, event)}
									>
										<span className="min-w-0 flex-1 truncate">{session.title}</span>
										<span className="shrink-0 text-ink-muted tabular-nums">{ago(session.updated)}</span>
									</button>
								</li>
							))}
						</ul>
					</li>
				))}
			</ul>
		),
	});
}
