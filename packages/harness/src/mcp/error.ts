import { Schema } from "effect";

/** The server could not be started, reached or initialized. */
export class ConnectError extends Schema.TaggedError<ConnectError>()("Mcp.ConnectError", {
	server: Schema.String,
	message: Schema.String,
}) {}

/**
 * The server rejected the connection until the user signs in. `scope` is set when it asked for more
 * scope than the token was granted, so the next sign-in requests it.
 */
export class NeedsAuthError extends Schema.TaggedError<NeedsAuthError>()("Mcp.NeedsAuthError", {
	server: Schema.String,
	message: Schema.String,
	scope: Schema.optional(Schema.String),
	resourceMetadataUrl: Schema.optional(Schema.String),
}) {}

/** Signing in to or out of a server failed, or its stored credentials could not be read or written. */
export class OAuthError extends Schema.TaggedError<OAuthError>()("Mcp.OAuthError", {
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

/**
 * The server cannot take the request: disabled, shut down, not connected, waiting for sign-in, or no
 * longer offering the tool. `message` is what the model reads.
 */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Mcp.UnavailableError", {
	server: Schema.String,
	message: Schema.String,
}) {}

/** A tool call or resource request reached the server and failed. `message` is what the model reads. */
export class ToolCallError extends Schema.TaggedError<ToolCallError>()("Mcp.ToolCallError", {
	server: Schema.String,
	tool: Schema.String,
	message: Schema.String,
}) {}

/** A resource tool was called with arguments it cannot use, or for a server without resources. */
export class ResourceError extends Schema.TaggedError<ResourceError>()("Mcp.ResourceError", {
	message: Schema.String,
}) {}

/** A server's `env` or `headers` value could not be resolved. */
export class ValueError extends Schema.TaggedError<ValueError>()("Mcp.ValueError", {
	message: Schema.String,
}) {}

/** Output the model is not shown in full could not be saved to a file. */
export class OutputError extends Schema.TaggedError<OutputError>()("Mcp.OutputError", {
	message: Schema.String,
}) {}

/** What an MCP-backed tool can fail with; each says in `message` what happened. */
export type Failure = UnavailableError | ToolCallError | ResourceError;

/** A failure inside the stdio transport, reported to the SDK through `onerror` or a rejected promise. */
export class StdioError extends Schema.TaggedError<StdioError>()("Mcp.StdioError", {
	message: Schema.String,
}) {}

export * as McpError from "./error.ts";
