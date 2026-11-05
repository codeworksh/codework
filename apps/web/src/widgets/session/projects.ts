import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useEffect, useMemo } from "react";

import { makeHost } from "../../kernel/host";
import { Server } from "../../kernel/rpc";
import { codeworkKey } from "../../kernel/servers";
import { Json, topics } from "./schema";

const decodeActivity = Schema.decodeUnknownOption(Json.Activity);

/** Every project with its sessions, as the sidebar lists them; refresh it once a new session exists. */
export const projectsAtom = Server.query("projects.list", undefined, { reactivityKeys: codeworkKey });

/** The sessions the agent works on, followed or not, as the Session backend sees runs start and end. */
export const workingAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive);

/** Keeps {@link workingAtom} current; mounted once, at the app's root. */
export function useWorkingFeed() {
	const registry = useContext(RegistryContext);
	const bus = useMemo(() => makeHost({ registry, package: "codework", instanceId: "activity" }).bus, [registry]);
	const setWorking = useAtomSet(workingAtom);
	useEffect(() => {
		// A live change beats the answer to the first read, which may have been taken before it.
		let live = false;
		const apply = (payload: unknown) =>
			Option.map(decodeActivity(payload), ({ working }) => setWorking(new Set(working)));
		const stop = bus.subscribe({ topics: [topics.working] }, (item) => {
			if ("_tag" in item) return;
			live = true;
			apply(item.payload);
		});
		bus.request({ topic: topics.activity, payload: {} })
			.then((reply) => live || apply(reply.payload))
			.catch(() => undefined);
		return stop;
	}, [bus, setWorking]);
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
