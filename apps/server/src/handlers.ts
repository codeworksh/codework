import { Effect } from "effect";
import { Cli } from "./cli.ts";
import { Codework } from "./codework.ts";
import {
	type CliAction,
	Contract,
	ModelsError,
	type Project,
	type ServerAdd,
	type ServerUpdate,
} from "@codeworksh/contract";
import { Desk } from "./desk.ts";
import { Event } from "./event.ts";
import { Health } from "./health.ts";
import { Kv } from "./kv.ts";
import { Servers } from "./servers.ts";
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
		const desk = yield* Desk.handlers;
		const events = yield* Event.Service;
		const kv = yield* Kv.Service;
		const servers = yield* Servers.Service;
		const health = yield* Health.Service;
		// A failed call is the first sign the default server went down.
		const call = <A, E>(use: Parameters<typeof Codework.call<A, E>>[0]) =>
			Codework.call(use).pipe(Effect.tapError(() => health.poke));
		// A changed default reconnects the app; the status read after waits for it to reach the server.
		const changingDefault = <A, E, R>(change: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				const before = yield* servers.defaultHome;
				yield* change;
				if ((yield* servers.defaultHome) !== before) yield* Cli.awaitConnection;
			});

		return Contract.Api.of({
			...workspaces,
			...desk,

			"projects.list": Effect.fn("projects.list")(function* () {
				return byProject(yield* call((client) => client("session.list", {})));
			}),

			// The catalog's own errors are kept apart from an unreachable server, so their detail shows.
			"models.list": Effect.fn("models.list")(function* ({ hostDir }) {
				const listed = yield* call((client) =>
					client("model.list", hostDir === undefined ? {} : { hostDir }).pipe(
						Effect.map((list) => ({ list })),
						Effect.catchTags({
							SettingsError: (error) =>
								Effect.succeed({
									failed: new ModelsError({ source: "settings", path: error.path, message: error.detail }),
								}),
							"Runner.ModelCatalogError": (error) =>
								Effect.succeed({
									failed: new ModelsError({ source: "catalog", path: error.path, message: error.detail }),
								}),
						}),
					),
				);
				if ("failed" in listed) return yield* listed.failed;
				return listed.list;
			}),

			"servers.watch": () => health.changes,
			"servers.check": () => health.check,
			"servers.health": () => health.settings,
			"servers.setHealth": (settings) => health.setSettings(settings),
			"servers.add": Effect.fn("servers.add")(function* (input: ServerAdd) {
				return yield* servers.add(input).pipe(Effect.tap(() => health.check));
			}),
			"servers.update": Effect.fn("servers.update")(function* (input: ServerUpdate) {
				yield* changingDefault(servers.update(input));
				yield* health.check;
			}),
			"servers.remove": Effect.fn("servers.remove")(function* ({ id }: { readonly id: string }) {
				yield* servers.remove(id);
				yield* health.check;
			}),
			"servers.setDefault": Effect.fn("servers.setDefault")(function* ({ id }: { readonly id: string }) {
				yield* changingDefault(servers.setDefault(id));
				yield* health.check;
			}),
			"servers.service": Effect.fn("servers.service")(function* ({
				id,
				action,
			}: {
				readonly id: string;
				readonly action: CliAction;
			}) {
				// Checked again whether it worked or not, so the status shows what the CLI left.
				yield* Cli.service(yield* servers.get(id), action).pipe(Effect.ensuring(health.check));
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
