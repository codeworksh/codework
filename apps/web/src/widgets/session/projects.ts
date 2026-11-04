import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { Server } from "../../kernel/rpc";
import { codeworkKey } from "../../kernel/servers";

/** Every project with its sessions, as the sidebar lists them; refresh it once a new session exists. */
export const projectsAtom = Server.query("projects.list", undefined, { reactivityKeys: codeworkKey });

/** Running session frames, keyed by instance so closing one never clears another's activity. */
export const runningAtom = Atom.make<ReadonlyMap<string, string>>(new Map()).pipe(Atom.keepAlive);

export function useSessionRunning(instanceId: string, sessionId: string, running: boolean) {
	const setRunning = useAtomSet(runningAtom);
	useEffect(() => {
		if (!running) return;
		setRunning((current) => new Map(current).set(instanceId, sessionId));
		return () =>
			setRunning((current) => {
				const next = new Map(current);
				next.delete(instanceId);
				return next;
			});
	}, [instanceId, sessionId, running, setRunning]);
}

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
