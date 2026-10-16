import { Effect } from "effect";
import { Codework } from "./codework.ts";
import { Contract, type Project } from "./contract.ts";
import { Event } from "./event.ts";
import { Kv } from "./kv.ts";
import { Workspaces } from "./workspaces.ts";

/**
 * Sessions grouped by project, both newest first. A session whose project row is missing gets a
 * group of its own folder, so it still shows rather than vanishing.
 */
const byProject = (sessions: ReadonlyArray<Codework.SessionInfo>): Project[] => {
	const groups = new Map<string, Project & { sessions: Project["sessions"][number][] }>();
	for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
		const folder = session.hostDir ?? session.directory;
		const key = session.project?.id ?? folder;
		const group = groups.get(key) ?? {
			id: key,
			name: session.project?.name ?? folder.split("/").at(-1) ?? folder,
			// The newest session's folder: where the project was last worked on.
			path: folder,
			sessions: [],
		};
		group.sessions.push({
			id: session.id,
			title: session.title,
			updated: session.updatedAt,
			...(session.model === undefined ? {} : { model: session.model }),
		});
		groups.set(key, group);
	}
	return [...groups.values()];
};

export const layer = Contract.Api.toLayer(
	Effect.gen(function* () {
		const workspaces = yield* Workspaces.handlers;
		const events = yield* Event.Service;
		const kv = yield* Kv.Service;

		return Contract.Api.of({
			...workspaces,

			"projects.list": Effect.fn("projects.list")(function* () {
				const sessions = yield* Codework.call((client) => client("session.list", {}));
				return byProject(sessions);
			}),

			"kv.get": ({ package: pkg, key }) => kv.get(pkg, key),
			"kv.set": ({ package: pkg, key, value }) => kv.set(pkg, key, value),

			"event.publish": (input) => events.publish(input),
			"event.request": (input) => events.request(input),
			"event.subscribe": (input) => events.subscribe(input),
		});
	}),
);

export * as Handlers from "./handlers.ts";
