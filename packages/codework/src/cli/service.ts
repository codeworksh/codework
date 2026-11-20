import { Global } from "@codeworksh/harness/effect";
import { Door } from "@codeworksh/schema";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { RpcClientError } from "effect/rpc";
import * as Client from "../server/client.ts";
import type * as Discovery from "../server/discovery.ts";
import * as Registration from "../server/registration.ts";
import { Cmd } from "./cmd/cmd.ts";

interface Shared {
	readonly userConfigDir: Option.Option<string>;
	readonly home: Option.Option<string>;
	readonly database: Option.Option<string>;
}

/** The CodeWork home the shared flags name, resolved the way the harness resolves it. */
export const home = (shared: Shared) => Global.resolve(Option.isSome(shared.home) ? { home: shared.home.value } : {});

/**
 * How `service` finds or starts the background server: the home whose
 * `service.json` names it, and the server-owned flags it is started with, in the
 * order `serve` parses them.
 */
export const options = (shared: Shared, server: { readonly host: string; readonly port: number }) =>
	home(shared).pipe(
		Effect.map((paths): Discovery.Options => ({
			home: paths.home,
			log: paths.log,
			...server,
			args: [
				...(Option.isSome(shared.home) ? ["--home", shared.home.value] : []),
				...(Option.isSome(shared.database) ? ["--database", shared.database.value] : []),
				...(Option.isSome(shared.userConfigDir) ? ["--user-config-dir", shared.userConfigDir.value] : []),
			],
		})),
	);

class ConnectError extends Schema.TaggedError<ConnectError>()("CLI.ConnectError", {
	message: Schema.String,
}) {}

const isClientError = Schema.is(RpcClientError.RpcClientError);

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Two URLs of one server: equal, or the same port and path under two loopback names. */
const same = (a: string, b: string) => {
	if (a === b) return true;
	const [x, y] = [URL.parse(a), URL.parse(b)];
	return (
		x !== null &&
		y !== null &&
		loopback.has(x.hostname) &&
		loopback.has(y.hostname) &&
		x.port === y.port &&
		x.pathname === y.pathname
	);
};

/**
 * The server at `url`, which must be the one the home's `service.json` names: the token goes nowhere
 * else, as any other server, however local it looks, may belong to someone else. A loopback alias
 * of that URL is the server as filed.
 */
const target = Effect.fn("CLI.target")(function* (url: string) {
	const paths = yield* home(yield* Cmd.spec);
	const registered = yield* Registration.read(Registration.file(paths.home));
	if (registered === undefined)
		return yield* new ConnectError({
			message: ["no CodeWork server is running for this home", "hint: start one with `codework service start`"].join(
				"\n",
			),
		});
	if (!same(registered.url, url))
		return yield* new ConnectError({
			message: [
				`${url} is not this home's server`,
				`hint: this home's server is ${registered.url}; pass --home for another home's server`,
			].join("\n"),
		});
	return { url: registered.url, token: registered.token };
});

/**
 * Why a socket to `server` did not open. The WebSocket hides the HTTP status, so the same request
 * is made again as a plain GET, with the token offered the same way, and the door's status read.
 */
const refused = Effect.fn("CLI.refused")(function* (url: string, server: Client.Target) {
	const status = yield* HttpClient.get(server.url.replace(/^ws/, "http"), {
		headers: { "sec-websocket-protocol": Door.protocols(server.token).join(", ") },
	}).pipe(
		Effect.map((response) => response.status),
		Effect.timeout("2 seconds"),
		Effect.provide(FetchHttpClient.layer),
		Effect.orElseSucceed(() => undefined),
	);
	switch (status) {
		case 401:
			return yield* new ConnectError({
				message: [
					`the CodeWork server at ${url} refused this home's token`,
					"hint: restart it with `codework service restart`, or check --home names its home",
				].join("\n"),
			});
		case 403:
			return yield* new ConnectError({
				message: `the CodeWork server at ${url} refused the request's host or origin`,
			});
		default:
			return yield* new ConnectError({
				message: [
					`could not connect to the CodeWork server at ${url}`,
					"hint: check it is running with `codework service status`",
				].join("\n"),
			});
	}
});

/** Runs `program` against the server at `url`, naming why when its socket does not open. */
export const connect =
	(url: string) =>
	<A, E, R>(program: Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			const server = yield* target(url);
			return yield* program.pipe(
				// Scoped inside the client, so the program's own finalizers still reach the server.
				Effect.scoped,
				Effect.provide(Client.layer(server)),
				Effect.catchIf(
					(error) => isClientError(error) && error.reason._tag === "SocketOpenError",
					() => refused(url, server),
				),
			);
		});
