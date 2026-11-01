import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";

import { Server } from "../../kernel/rpc";
import { codeworkKey } from "../../kernel/servers";

/** Every project with its sessions, as the sidebar lists them; refresh it once a new session exists. */
export const projectsAtom = Server.query("projects.list", undefined, { reactivityKeys: codeworkKey });

const listedAtom = Atom.family((id: string) =>
	Atom.make((get) => {
		const result = get(projectsAtom);
		if (!AsyncResult.isSuccess(result)) return undefined;
		for (const project of result.value) {
			const session = project.sessions.find((candidate) => candidate.id === id);
			if (session !== undefined) return { title: session.title, project: { id: project.id, name: project.name } };
		}
		return undefined;
	}),
);

/** What the list already says about a session: its title and project name, before it is loaded. */
export const useListedSession = (id: string) => useAtomValue(listedAtom(id));
