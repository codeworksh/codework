import { Schema } from "effect";

/** The server could not be started, reached or initialized. */
export class ConnectError extends Schema.TaggedError<ConnectError>()("Mcp.ConnectError", {
	server: Schema.String,
	message: Schema.String,
}) {}

/** The server rejected the connection until the user signs in. */
export class NeedsAuthError extends Schema.TaggedError<NeedsAuthError>()("Mcp.NeedsAuthError", {
	server: Schema.String,
	message: Schema.String,
}) {}

/** A Streamable HTTP server no longer knows this connection's session; the caller reconnects. */
export class SessionExpiredError extends Schema.TaggedError<SessionExpiredError>()("Mcp.SessionExpiredError", {
	server: Schema.String,
}) {
	override get message(): string {
		return `mcp server session expired: ${this.server}`;
	}
}

/** A request on a connected server failed. */
export class RequestError extends Schema.TaggedError<RequestError>()("Mcp.RequestError", {
	server: Schema.String,
	method: Schema.String,
	message: Schema.String,
}) {}

/** A failure inside the stdio transport, reported to the SDK through `onerror` or a rejected promise. */
export class StdioError extends Schema.TaggedError<StdioError>()("Mcp.StdioError", {
	message: Schema.String,
}) {}

export * as McpError from "./error.ts";
