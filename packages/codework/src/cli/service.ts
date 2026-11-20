import { Global } from "@codeworksh/harness/effect";
import { Effect, Layer, Option, Schema } from "effect";
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
 * A client of the server at `url`, which must be the one the home's `service.json` names: the token
 * goes nowhere else, as any other server, however local it looks, may belong to someone else. A
 * loopback alias of that URL connects to it as filed.
 */
const client = (url: string) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const paths = yield* home(yield* Cmd.spec);
			const registered = yield* Registration.read(Registration.file(paths.home));
			if (registered === undefined)
				return yield* new ConnectError({
					message: [
						"no CodeWork server is running for this home",
						"hint: start one with `codework service start`",
					].join("\n"),
				});
			if (!same(registered.url, url))
				return yield* new ConnectError({
					message: [
						`${url} is not this home's server`,
						`hint: this home's server is ${registered.url}; pass --home for another home's server`,
					].join("\n"),
				});
			return Client.layer({ url: registered.url, token: registered.token });
		}),
	);

/**
 * Runs `program` against the server at `url`. A socket that does not open names no reason: the
 * WebSocket hides the HTTP status, so a refused token, a stopped server and a wrong port look alike.
 */
export const connect =
	(url: string) =>
	<A, E, R>(program: Effect.Effect<A, E, R>) =>
		program.pipe(
			// Scoped inside the client, so the program's own finalizers still reach the server.
			Effect.scoped,
			Effect.provide(client(url)),
			Effect.mapError((error) =>
				isClientError(error) && error.reason._tag === "SocketOpenError"
					? new ConnectError({
							message: [
								`could not connect to the CodeWork server at ${url}`,
								"hint: check it is running with `codework service status`",
							].join("\n"),
						})
					: error,
			),
		);
