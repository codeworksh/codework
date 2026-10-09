import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Folder } from "lucide-react";

import { Server, useShell } from "../../sdk";
import { sessionAddress } from "./address";
import { ago } from "./time";

const list = Server.query("projects.list", undefined);

const isMac = navigator.platform.startsWith("Mac");

export function Projects() {
	const shell = useShell();
	const result = useAtomValue(list);

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
										title={`Open session (${isMac ? "⌘" : "Ctrl"}-click for a new one)`}
										className="flex w-full items-baseline gap-2 rounded-md py-1 pr-1.5 pl-6.5 text-left hover:bg-ink/5"
										onClick={(event) =>
											shell.open(sessionAddress(session.id), {
												fresh: isMac ? event.metaKey : event.ctrlKey,
											})
										}
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
