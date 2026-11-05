import { Effect, Stream } from "effect";
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
import { Sync } from "./sync.ts";
import { Workspaces } from "./workspaces.ts";

/**
 * Sessions grouped by project, both newest first, each shown as its main thread. A session whose
 * project row is missing gets a group of its own folder, so it still shows rather than vanishing.
 */
const byProject = (threads: ReadonlyArray<Codework.ThreadInfo>): Project[] => {
	const groups = new Map<string, Project & { sessions: Project["sessions"][number][] }>();
	const mains = threads.filter((thread) => thread.origin.kind === "main");
	for (const thread of [...mains].sort((a, b) => b.updatedAt - a.updatedAt)) {
		const session = thread.session;
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
			title: thread.title ?? Codework.UNTITLED,
			updated: thread.updatedAt,
			...(thread.model === undefined ? {} : { model: thread.model }),
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
		const sync = yield* Sync.Service;
		// A failed call is the first sign the default server went down.
		const call = <A, E>(use: Parameters<typeof Codework.call<A, E>>[0], options?: Codework.CallOptions) =>
			Codework.call(use, options).pipe(Effect.tapError(() => health.poke));
		const callHost = <A, E>(use: Parameters<typeof Codework.callHost<A, E>>[0], options?: Codework.CallOptions) =>
			Codework.callHost(use, options).pipe(
				Effect.tapError((error) => (error._tag === "Server.CodeworkUnavailable" ? health.poke : Effect.void)),
			);
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
				return byProject(yield* call((client) => client("thread.list", {})));
			}),

			"host.info": Effect.fn("host.info")(function* () {
				return yield* call((client) => client("host.info", {}));
			}),
			"host.browse": Effect.fn("host.browse")(function* ({ path }) {
				return yield* callHost((client) => client("host.browse", { path }));
			}),
			// Creating runs git init and a first commit, well past the default 5 seconds.
			"host.create": Effect.fn("host.create")(function* ({ name }) {
				return yield* callHost((client) => client("host.create", { name }), { timeout: "60 seconds" });
			}),
			"host.add": Effect.fn("host.add")(function* ({ path }) {
				return yield* callHost((client) => client("host.add", { path }));
			}),
			"host.clone": Effect.fn("host.clone")(function* ({ remote, path }) {
				return yield* callHost((client) => client("host.clone", { remote, path }));
			}),
			"host.clones": () =>
				Codework.stream((client) => client("host.clones", {})).pipe(Stream.tapError(() => health.poke)),
			"host.cancel": Effect.fn("host.cancel")(function* ({ path }) {
				return yield* call((client) => client("host.cancel", { path }));
			}),
			"host.retry": Effect.fn("host.retry")(function* ({ path }) {
				return yield* callHost((client) => client("host.retry", { path }));
			}),
			"host.discard": Effect.fn("host.discard")(function* ({ path }) {
				return yield* call((client) => client("host.discard", { path }));
			}),
			// gh checks its token, and looks repositories up, over the network.
			"github.status": Effect.fn("github.status")(function* () {
				return yield* call((client) => client("github.status", {}), { timeout: "30 seconds" });
			}),
			"github.lookup": Effect.fn("github.lookup")(function* ({ repository }) {
				return yield* callHost((client) => client("github.lookup", { repository }), { timeout: "30 seconds" });
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
				yield* Cli.service(yield* servers.getLocal(id), action).pipe(Effect.ensuring(health.check));
			}),

			"sync.open": (ref) => sync.open(ref),
			"sync.close": (ref) => sync.close(ref),
			"sync.page": (input) => sync.page(input),

			"kv.get": ({ package: pkg, key }) => kv.get(pkg, key),
			"kv.set": ({ package: pkg, key, value }) => kv.set(pkg, key, value),

			"event.publish": (input) => events.publish(input),
			"event.request": (input) => events.request(input),
			"event.subscribe": (input) => events.subscribe(input),
		});
	}),
);

export * as Handlers from "./handlers.ts";
