import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { Server } from "../../kernel/rpc";

/** Every project with its sessions, as the sidebar lists them; refresh it once a new session exists. */
export const projectsAtom = Server.query("projects.list", undefined);

/** What the list already says about a session: its title and project name, before it is loaded. */
export function useListedSession(id: string) {
	const result = useAtomValue(projectsAtom);
	if (!AsyncResult.isSuccess(result)) return undefined;
	for (const project of result.value) {
		const session = project.sessions.find((candidate) => candidate.id === id);
		if (session !== undefined) return { title: session.title, project: project.name };
	}
	return undefined;
}
