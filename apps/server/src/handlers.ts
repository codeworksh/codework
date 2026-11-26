import { Codework as Client } from "@codeworksh/widget/backend";
import type * as Mirror from "@codeworksh/widget/codework";
import { Effect, Predicate, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { Changes } from "./changes.ts";
import { Cli } from "./cli.ts";
import { Codework } from "./codework.ts";
import {
	type CliAction,
	CodeworkUnavailable,
	Contract,
	ModelsError,
	ProjectError,
	type ServerAdd,
	ServersError,
	SettingsConflict,
	SettingsError,
	type ServerUpdate,
	syncTopics,
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
import { Tabs } from "./tabs.ts";
import { Tracking } from "./tracking.ts";

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
		const tabs = yield* Tabs.handlers;
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
		/** A machine's name for its errors, or a stand-in once it is gone. */
		const nameOf = (machineId: string) =>
			servers.get(machineId).pipe(
				Effect.map(({ name }) => name),
				Effect.orElseSucceed(() => "That machine"),
			);
		/** A machine's connection, as Sync holds it; not connected, it says so by the machine's name. */
		const connection = (machineId: string) =>
			sync.client(machineId).pipe(
				// One added twice keeps Sync's own reason; any other is not connected, said by its name.
				Effect.catch((error) =>
					sync.isDuplicate(machineId)
						? Effect.fail(error)
						: Effect.flatMap(nameOf(machineId), (name) =>
								Effect.fail(new CodeworkUnavailable({ message: `${name} is not connected.` })),
							),
				),
			);
		/**
		 * A host call on `machineId`'s server, else the default one's. A named machine that does not answer
		 * says so by name: the default server's advice to start it does not fit a machine elsewhere.
		 */
		const onMachine =
			(machineId: string | undefined) =>
			<A, E, R>(effect: Effect.Effect<A, E, R>) =>
				machineId === undefined
					? effect
					: connection(machineId).pipe(
							Effect.flatMap((client) =>
								Effect.provideService(effect, Client, client).pipe(
									Effect.catchIf(
										(error) => error instanceof CodeworkUnavailable,
										() =>
											Effect.flatMap(nameOf(machineId), (name) =>
												Effect.fail(new CodeworkUnavailable({ message: `${name} did not answer.` })),
											),
									),
								),
							),
						);
		/** {@link onMachine} for a stream: it fails at once when the machine is not connected. */
		const streamOnMachine =
			(machineId: string | undefined) =>
			<A, E, R>(stream: Stream.Stream<A, E, R>) =>
				machineId === undefined
					? stream
					: Stream.unwrap(
							Effect.map(connection(machineId), (client) => Stream.provideService(stream, Client, client)),
						);
		/**
		 * A project call: a project the server no longer has is its answer, kept apart from an unreachable
		 * server, which is all a failure inside a call otherwise turns into.
		 */
		const projectCall = <A, E>(use: Parameters<typeof Codework.callHost<A, E>>[0]) =>
			callHost((client) =>
				use(client).pipe(
					Effect.map((value) => ({ value })),
					Effect.catchIf(
						(error): error is Extract<typeof error, { readonly _tag: "ProjectNotFoundError" }> =>
							Predicate.hasProperty(error, "_tag") && error._tag === "ProjectNotFoundError",
						() => Effect.succeed({ gone: true as const }),
					),
				),
			).pipe(
				Effect.flatMap((reply) =>
					"gone" in reply
						? Effect.fail(new ProjectError({ message: "This project is no longer on its server." }))
						: Effect.succeed(reply.value),
				),
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
		/**
		 * The connection to a paired machine, in the app's own words when there is none: refused once it is
		 * not paired any more, its address answers as another machine or its clock is apart, or not answering.
		 */
		const paired = Effect.fn("paired")(function* (id: string) {
			const row = yield* servers.get(id);
			if (row.kind !== "remote")
				return yield* new ServersError({ message: "Only a paired Machine is reached here." });
			if (row.device === null)
				return yield* new ServersError({ message: `${row.name} is not paired any more. Pair it again.` });
			if (row.mismatch?.kind === "machine")
				return yield* new ServersError({ message: "This address answers as a different Machine. Pair it again." });
			if (row.mismatch?.kind === "clock")
				return yield* new ServersError({ message: "This computer’s clock differs from the Machine’s." });
			const unanswered = new ServersError({ message: `${row.name} did not answer.` });
			const client = yield* sync.client(id).pipe(Effect.mapError(() => unanswered));
			return { client, unanswered };
		});
		/** Stores what a paired machine's own record says now, so a link or an unlink shows at once. */
		const reread = (id: string, client: typeof Client.Service) =>
			Codework.call((rpc) => rpc("machine.info", {})).pipe(
				Effect.provideService(Client, client),
				Effect.flatMap((status) => servers.reached(id, Servers.factsOf(status))),
				Effect.andThen(health.check),
				Effect.ignore,
			);
		// A changed default reconnects the app; the status read after waits for it to reach the server.
		const changingDefault = <A, E, R>(change: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				const before = yield* servers.defaultHome;
				yield* change;
				if ((yield* servers.defaultHome) !== before) yield* Cli.awaitConnection;
			});

		return Contract.Api.of({
			...tabs,
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

			"machine.info": Effect.fn("machine.info")(function* () {
				return yield* call((client) => client("machine.info", {}));
			}),
			"machine.rename": Effect.fn("machine.rename")(function* ({ givenName }) {
				return yield* call((client) => client("machine.rename", { givenName }));
			}),
			// The CLI's own failure (not connected to that workspace) keeps its message.
			"machine.disconnect": Effect.fn("machine.disconnect")(function* ({ serverId, ...input }) {
				const disconnect = (client: typeof Client.Service) =>
					client("machine.disconnect", input).pipe(
						Effect.map((disconnected) => ({ disconnected })),
						Effect.catchTag("Machine.ConnectError", (failed) => Effect.succeed({ failed })),
					);
				if (serverId === undefined) {
					const reply = yield* call(disconnect);
					return yield* "failed" in reply ? Effect.fail(reply.failed) : Effect.succeed(reply.disconnected);
				}
				const { client, unanswered } = yield* paired(serverId);
				const reply = yield* Codework.call(disconnect).pipe(
					Effect.provideService(Client, client),
					Effect.mapError(() => unanswered),
				);
				if ("failed" in reply) return yield* reply.failed;
				yield* servers.reached(serverId, Servers.factsOf(reply.disconnected.status));
				yield* health.check;
				return reply.disconnected;
			}),
			// The CLI's own connect failure (the relay unreachable, the code expired) keeps its message; only
			// a dropped server reads as unavailable, and a paired machine as not answering.
			"machine.connect": ({ workspaceId, serverId }) => {
				const connect = (client: typeof Client.Service) =>
					client("machine.connect", { workspaceId }).pipe(
						Stream.map((event) => ({ event })),
						Stream.catchTag("Machine.ConnectError", (failed) => Stream.succeed({ failed })),
					);
				const unwrap = Stream.flatMap((item: Stream.Success<ReturnType<typeof connect>>) =>
					"failed" in item ? Stream.fail(item.failed) : Stream.succeed(item.event),
				);
				if (serverId === undefined) return Codework.stream(connect).pipe(unwrap);
				return Stream.unwrap(
					paired(serverId).pipe(
						Effect.map(({ client, unanswered }) =>
							Codework.stream(connect).pipe(
								Stream.provideService(Client, client),
								Stream.mapError(() => unanswered),
								unwrap,
								// Stored before the link reaches the app, so the machine's status already shows it.
								Stream.tap((event) => (event._tag === "Connected" ? reread(serverId, client) : Effect.void)),
							),
						),
					),
				);
			},
			"host.info": Effect.fn("host.info")(function* ({ machineId }) {
				return yield* onMachine(machineId)(call((client) => client("host.info", {})));
			}),
			"host.browse": Effect.fn("host.browse")(function* ({ machineId, path }) {
				const listed = yield* onMachine(machineId)(callHost((client) => client("host.browse", { path })));
				return { ...listed, readable: listed.readable ?? true };
			}),
			// Creating runs git init and a first commit, well past the default 5 seconds.
			"host.create": Effect.fn("host.create")(function* ({ machineId, name }) {
				return yield* onMachine(machineId)(
					callHost((client) => client("host.create", { name }), { timeout: "60 seconds" }),
				);
			}),
			"projects.remote": Effect.fn("projects.remote")(function* ({ machineId, projectId }) {
				return yield* onMachine(machineId)(projectCall((client) => client("project.remote", { projectId })));
			}),
			// A project's files are on its machine; the host is not told which machine it is.
			"settings.read": ({ machineId, ...input }) =>
				onMachine(machineId)(settingsCall((client) => client("settings.read", input))),
			"settings.write": ({ machineId, ...input }) =>
				onMachine(machineId)(settingsCall((client) => client("settings.write", input))),
			"settings.set": ({ machineId, ...input }) =>
				onMachine(machineId)(settingsCall((client) => client("settings.set", input))),
			"projects.rename": Effect.fn("projects.rename")(function* ({ machineId, projectId, name }) {
				return yield* onMachine(machineId)(projectCall((client) => client("project.rename", { projectId, name })));
			}),
			"host.add": Effect.fn("host.add")(function* ({ machineId, path }) {
				return yield* onMachine(machineId)(callHost((client) => client("host.add", { path })));
			}),
			"host.clone": Effect.fn("host.clone")(function* ({ machineId, remote, path }) {
				return yield* onMachine(machineId)(callHost((client) => client("host.clone", { remote, path })));
			}),
			"host.clones": ({ machineId }) =>
				streamOnMachine(machineId)(Codework.stream((client) => client("host.clones", {}))).pipe(
					// Only the default machine's failure says anything about the default server's health.
					Stream.tapError(() => (machineId === undefined ? health.poke : Effect.void)),
				),
			"host.cancel": Effect.fn("host.cancel")(function* ({ machineId, path }) {
				return yield* onMachine(machineId)(call((client) => client("host.cancel", { path })));
			}),
			"host.retry": Effect.fn("host.retry")(function* ({ machineId, path }) {
				return yield* onMachine(machineId)(callHost((client) => client("host.retry", { path })));
			}),
			"host.discard": Effect.fn("host.discard")(function* ({ machineId, path }) {
				return yield* onMachine(machineId)(call((client) => client("host.discard", { path })));
			}),
			// gh checks its token, and looks repositories up, over the network.
			"github.status": Effect.fn("github.status")(function* ({ machineId }) {
				return yield* onMachine(machineId)(
					call((client) => client("github.status", {}), { timeout: "30 seconds" }),
				);
			}),
			"github.lookup": Effect.fn("github.lookup")(function* ({ machineId, repository }) {
				return yield* onMachine(machineId)(
					callHost((client) => client("github.lookup", { repository }), { timeout: "30 seconds" }),
				);
			}),

			// The catalog's own errors are kept apart from an unreachable server, so their detail shows.
			"models.list": Effect.fn("models.list")(function* ({ machineId, hostDir }) {
				const listed = yield* onMachine(machineId)(
					call((client) =>
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
			"servers.label": Effect.fn("servers.label")(function* ({
				id,
				label,
			}: {
				readonly id: string;
				readonly label: string;
			}) {
				const row = yield* servers.get(id);
				if (row.kind !== "remote")
					return yield* new ServersError({ message: "Only a paired Machine has a Label." });
				const { client, unanswered } = yield* paired(id);
				const status = yield* Codework.call((rpc) => rpc("machine.rename", { givenName: label.trim() })).pipe(
					Effect.provideService(Client, client),
					Effect.mapError(() => unanswered),
				);
				yield* servers.reached(id, { label: status.givenName });
				yield* health.check;
			}),
			"servers.remove": Effect.fn("servers.remove")(function* ({ id }: { readonly id: string }) {
				const row = yield* servers.get(id);
				// Best effort: the row goes whether the machine answers or not.
				if (row.kind === "remote" && row.device !== null)
					yield* sync.client(id).pipe(
						Effect.flatMap((client) =>
							Codework.call((rpc) => rpc("device.leave", {}), { timeout: "3 seconds" }).pipe(
								Effect.provideService(Client, client),
							),
						),
						Effect.ignore,
					);
				// Its rows cascade away with it. What it holds is read in the same transaction, so a batch landing
				// meanwhile is named too, and the notice has every view read again.
				yield* events
					.transact((append) =>
						Effect.gen(function* () {
							const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);
							const sessions = yield* sql<{ id: string }>`SELECT id FROM session WHERE machine_id = ${id}`;
							const threads = yield* sql<{ id: string }>`
								SELECT thread.id FROM thread JOIN session ON session.id = thread.session_id
								WHERE session.machine_id = ${id}
							`;
							const spaces = yield* sql<{ id: string }>`SELECT id FROM space WHERE machine_id = ${id}`;
							const projects = yield* sql<{ id: string }>`SELECT id FROM project WHERE machine_id = ${id}`;
							yield* servers.remove(id);
							yield* append({
								topic: syncTopics.changed,
								source: "servers",
								payload: {
									machineId: id,
									full: true,
									items: 0,
									project: ids(projects),
									space: ids(spaces),
									session: [],
									thread: ids(threads),
									entry: [],
									inbox: [],
									removed: ids(sessions),
								},
							});
						}),
					)
					.pipe(Effect.catchTag("SqlError", Effect.die));
				yield* health.check;
			}),
			"servers.setDefault": Effect.fn("servers.setDefault")(function* ({ id }: { readonly id: string }) {
				yield* changingDefault(servers.setDefault(id));
				yield* health.check;
			}),
			"servers.install": Effect.fn("servers.install")(function* ({ id }: { readonly id: string }) {
				yield* Cli.install(yield* servers.getLocal(id)).pipe(Effect.ensuring(health.check));
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
