import type * as Mirror from "@codeworksh/widget/codework";
import { Effect, Predicate, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { Changes } from "./changes.ts";
import { Cli } from "./cli.ts";
import { Codework } from "./codework.ts";
import {
	type CliAction,
	Contract,
	ModelsError,
	ProjectError,
	type ServerAdd,
	SettingsConflict,
	SettingsError,
	type ServerUpdate,
} from "@codeworksh/contract";
import { Desk } from "./desk.ts";
import { Event } from "./event.ts";
import { Health } from "./health.ts";
import { Kv } from "./kv.ts";
import { Metrics } from "./metrics.ts";
import { Reads } from "./reads.ts";
import { Skills } from "./skills.ts";
import { Servers } from "./servers.ts";
import { Sync } from "./sync.ts";
import { Tracking } from "./tracking.ts";
import { Workspaces } from "./workspaces.ts";

type SettingsRefusal =
	| Mirror.SettingsError
	| Mirror.SettingsConflictError
	| Mirror.ProjectNotFoundError
	| Mirror.ProjectCheckoutError;

const refusals: ReadonlyArray<string> = [
	"SettingsError",
	"SettingsConflictError",
	"ProjectNotFoundError",
	"ProjectCheckoutError",
];
const isRefusal = (error: unknown): error is SettingsRefusal =>
	Predicate.hasProperty(error, "_tag") && refusals.includes(error._tag as string);

const refusal = (error: SettingsRefusal) => {
	switch (error._tag) {
		case "SettingsError":
			return new SettingsError({ path: error.path, message: error.detail });
		case "SettingsConflictError":
			return new SettingsConflict({ path: error.path });
		case "ProjectNotFoundError":
			return new ProjectError({ message: "This project is no longer on its server." });
		case "ProjectCheckoutError":
			return new ProjectError({ message: "This project has no folder on its server." });
	}
};

export const layer = Contract.Api.toLayer(
	Effect.gen(function* () {
		const workspaces = yield* Workspaces.handlers;
		const desk = yield* Desk.handlers;
		const tracking = yield* Tracking.handlers;
		const events = yield* Event.Service;
		const kv = yield* Kv.Service;
		const servers = yield* Servers.Service;
		const health = yield* Health.Service;
		const sync = yield* Sync.Service;
		const sql = yield* SqlClient.SqlClient;
		// A failed call is the first sign the default server went down.
		const call = <A, E>(use: Parameters<typeof Codework.call<A, E>>[0], options?: Codework.CallOptions) =>
			Codework.call(use, options).pipe(Effect.tapError(() => health.poke));
		const callHost = <A, E>(use: Parameters<typeof Codework.callHost<A, E>>[0], options?: Codework.CallOptions) =>
			Codework.callHost(use, options).pipe(
				Effect.tapError((error) => (error._tag === "Server.CodeworkUnavailable" ? health.poke : Effect.void)),
			);
		/** A settings call: the server's refusals reach the app with their reason; anything else is an unreachable server. */
		const settingsCall = <A, E>(use: Parameters<typeof Codework.call<A, E>>[0]) =>
			call((client) =>
				use(client).pipe(
					Effect.map((value) => ({ value })),
					Effect.catch((error) =>
						isRefusal(error) ? Effect.succeed({ failed: refusal(error) }) : Effect.fail(error),
					),
				),
			).pipe(
				Effect.flatMap((reply) => ("failed" in reply ? Effect.fail(reply.failed) : Effect.succeed(reply.value))),
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
			...tracking,

			"sidebar.list": (input) => Reads.sidebar(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
			"projects.spaces": (input) => Reads.spaces(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
			"projects.skills": (input) =>
				Skills.list(input, sync.client(input.machineId)).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
			"changes.status": (input) => Changes.status(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
			"changes.space": (input) =>
				Changes.space(input, sync.client(input.machineId)).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
			"changes.diff": (input) => Changes.diff(input, sync.client(input.machineId)),
			"threads.list": (input) => Reads.threads(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
			"threads.line": (input) => Reads.line(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
			"metrics.usage": (input) => Metrics.usage(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
			"metrics.hours": (input) => Metrics.hours(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),

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
			"projects.remote": Effect.fn("projects.remote")(function* ({ projectId }) {
				return yield* callHost((client) =>
					client("project.remote", { projectId }).pipe(
						Effect.catchTag("ProjectNotFoundError", () =>
							Effect.fail(new ProjectError({ message: "This project is no longer on its server." })),
						),
					),
				);
			}),
			"settings.read": (input) => settingsCall((client) => client("settings.read", input)),
			"settings.write": (input) => settingsCall((client) => client("settings.write", input)),
			"settings.set": (input) => settingsCall((client) => client("settings.set", input)),
			"projects.rename": Effect.fn("projects.rename")(function* ({ projectId, name }) {
				return yield* callHost((client) =>
					client("project.rename", { projectId, name }).pipe(
						Effect.catchTag("ProjectNotFoundError", () =>
							Effect.fail(new ProjectError({ message: "This project is no longer on its server." })),
						),
					),
				);
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
