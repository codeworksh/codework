/* @effect-diagnostics nodeBuiltinImport:off -- the loopback callback is a plain node:http listener. */
/**
 * The loopback server an OAuth sign-in redirects the browser to. It listens for the length of the
 * calling scope and hands each authorization response to the sign-in waiting for its `state`.
 */

import { createServer, type ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "@codeworksh/aikit/oauth/interactive";
import { Deferred, Effect, Schema } from "effect";

/** The listener could not start, or the authorization server answered with an error. */
export class CallbackError extends Schema.TaggedError<CallbackError>()("Mcp.CallbackError", {
	message: Schema.String,
}) {}

export interface Settings {
	/** Address to listen on. */
	readonly host: string;
	/** Host name in the redirect URI, `localhost` say while listening on `127.0.0.1`. */
	readonly redirectHost: string;
	readonly port?: number | undefined;
	readonly path: string;
}

export interface Response {
	readonly code: string;
	readonly iss?: string | undefined;
}

export interface Callback {
	readonly redirectUrl: string;
	/** The authorization response carrying `state`. */
	readonly wait: (state: string) => Effect.Effect<Response, CallbackError>;
}

const reply = (response: ServerResponse, status: number, html: string) =>
	response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);

const bind = (settings: Settings, port: number) =>
	Effect.acquireRelease(
		Effect.callback<{ server: ReturnType<typeof createServer>; port: number }, CallbackError>((resume) => {
			const server = createServer();
			server.once("error", (error) =>
				resume(Effect.fail(new CallbackError({ message: `OAuth callback could not listen: ${error.message}` }))),
			);
			server.listen(port, settings.host, () => {
				const address = server.address();
				resume(
					address !== null && typeof address === "object"
						? Effect.succeed({ server, port: address.port })
						: Effect.fail(new CallbackError({ message: "OAuth callback did not bind to a TCP port" })),
				);
			});
		}),
		({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
	);

/**
 * Listens on `settings.port`, or on a free port when that one is taken and not `required`: a
 * registered client's redirect port is preferred, not needed, since a new client can be registered.
 */
export const listen = Effect.fn("McpCallback.listen")(function* (settings: Settings, required: boolean) {
	const bound = yield* bind(settings, settings.port ?? 0).pipe(
		Effect.catch((error) => (required || settings.port === undefined ? Effect.fail(error) : bind(settings, 0))),
	);
	const host = settings.redirectHost.includes(":") ? `[${settings.redirectHost}]` : settings.redirectHost;
	const redirectUrl = `http://${host}:${bound.port}${settings.path}`;
	const pending = new Map<string, Deferred.Deferred<Response, CallbackError>>();

	bound.server.on("request", (request, response) => {
		const url = new URL(request.url ?? "/", redirectUrl);
		if (url.pathname !== settings.path) return reply(response, 404, oauthErrorHtml("Not found."));
		const state = url.searchParams.get("state");
		const waiting = state === null ? undefined : pending.get(state);
		if (state === null || waiting === undefined)
			return reply(response, 400, oauthErrorHtml("Invalid or expired OAuth state."));
		pending.delete(state);
		const error = url.searchParams.get("error");
		const code = url.searchParams.get("code");
		if (error !== null) {
			const description = url.searchParams.get("error_description") ?? error;
			Deferred.doneUnsafe(waiting, Effect.fail(new CallbackError({ message: description })));
			return reply(response, 200, oauthErrorHtml("Sign-in failed. You may close this window.", description));
		}
		if (code === null) {
			Deferred.doneUnsafe(
				waiting,
				Effect.fail(new CallbackError({ message: "The authorization response has no code" })),
			);
			return reply(response, 400, oauthErrorHtml("Missing authorization code."));
		}
		Deferred.doneUnsafe(waiting, Effect.succeed({ code, iss: url.searchParams.get("iss") ?? undefined }));
		reply(response, 200, oauthSuccessHtml("Signed in to the MCP server. You may close this window."));
	});

	return {
		redirectUrl,
		wait: (state) =>
			Effect.suspend(() => {
				const deferred = Deferred.makeUnsafe<Response, CallbackError>();
				pending.set(state, deferred);
				return Deferred.await(deferred).pipe(Effect.ensuring(Effect.sync(() => pending.delete(state))));
			}),
	} satisfies Callback;
});

export * as McpCallback from "./callback.ts";
