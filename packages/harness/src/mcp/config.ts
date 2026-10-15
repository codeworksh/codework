/**
 * MCP server configuration: `mcp.json` in the user config directory and in the project's
 * `.codework/`, in the `mcpServers` shape other MCP clients use, so an existing entry can be copied
 * over. A project entry replaces a user entry with the same name.
 *
 * A project entry without `command`, `url` or `type` overrides only `enabled`, `exposure` and
 * `toolExposure` of the user server with the same name, for example to turn it off in one project:
 * `{ "mcpServers": { "internal-tools": { "enabled": false } } }`. The rest of the user entry is kept,
 * including credentials the project could not set itself.
 *
 * Unlike `settings.jsonc`, a broken file or entry does not fail the read: it is reported and
 * skipped, so one bad server never keeps the others from connecting.
 */

import type { ServerConfig } from "@codeworksh/plugin/plugin/mcp";
import type { McpServer, McpSettings } from "@codeworksh/plugin/settings";
import { Effect, Predicate, Result } from "effect";
import { Global } from "../global.ts";
import { fileSystem, hostPath } from "../host.ts";
import * as Jsonc from "../util/jsonc.ts";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const EXPOSURES: ReadonlyArray<string> = ["direct", "hidden"];
const SCOPES: ReadonlyArray<string> = ["session", "space", "app"];
const OVERRIDE_KEYS: ReadonlyArray<string> = ["enabled", "exposure", "toolExposure"];

/** Names that differ only in `-` and `_` would give their tools the same names. */
export const namespace = (server: string) => `mcp__${server.replace(/-/g, "_")}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Predicate.isObject(value) && !Array.isArray(value);
const isStringRecord = (value: unknown): value is Record<string, string> =>
	isRecord(value) && Object.values(value).every(Predicate.isString);

/** Whether a project entry overrides a user server instead of defining one. */
const isOverride = (value: Record<string, unknown>) =>
	value.command === undefined && value.url === undefined && value.type === undefined;

/** One `mcpServers` entry, checked. Returns the config, or what is wrong with it. */
export const validate = (name: string, value: unknown): ServerConfig | string => {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(value)) return `server "${name}" must be an object`;
	const { type, exposure, enabled, timeout, toolExposure, description, scope } = value;
	const exposures = EXPOSURES.map((one) => `"${one}"`).join(", ");
	if (exposure !== undefined && !EXPOSURES.includes(exposure as string))
		return `server "${name}": exposure must be one of ${exposures}`;
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, one] of Object.entries(toolExposure)) {
			if (!EXPOSURES.includes(one as string))
				return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
		}
	}
	if (enabled !== undefined && !Predicate.isBoolean(enabled)) return `server "${name}": enabled must be a boolean`;
	if (scope !== undefined && !SCOPES.includes(scope as string))
		return `server "${name}": scope must be one of ${SCOPES.map((one) => `"${one}"`).join(", ")}`;
	if (description !== undefined && !Predicate.isString(description))
		return `server "${name}": description must be a string`;
	if (timeout !== undefined && !(Predicate.isNumber(timeout) && timeout > 0))
		return `server "${name}": timeout must be a positive number of seconds`;
	// Until sign-in exists, an entry relying on it could only fail; say so instead of ignoring the key.
	for (const key of ["auth", "oauth"])
		if (value[key] !== undefined) return `server "${name}": "${key}" is not supported yet`;
	if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;

	if (Predicate.isString(value.url) && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol))
			return `server "${name}": url must be an http or https URL`;
		if (value.headers !== undefined && !isStringRecord(value.headers))
			return `server "${name}": headers must map names to strings`;
		return value as unknown as ServerConfig;
	}
	if (Predicate.isString(value.command) && (type === undefined || type === "stdio")) {
		if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every(Predicate.isString)))
			return `server "${name}": args must be an array of strings`;
		if (value.env !== undefined && !isStringRecord(value.env))
			return `server "${name}": env must map names to strings`;
		if (value.cwd !== undefined && !Predicate.isString(value.cwd)) return `server "${name}": cwd must be a string`;
		return value as unknown as ServerConfig;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
};

/** The server whose name differs from `name` only in `-` and `_`, if there is one. */
export const clash = (names: Iterable<string>, name: string) => {
	for (const other of names) if (other !== name && namespace(other) === namespace(name)) return other;
	return undefined;
};

interface State {
	readonly servers: Map<string, McpServer>;
	readonly errors: string[];
}

const read = Effect.fnUntraced(function* (path: string, scope: "user" | "project", state: State) {
	const source = yield* Effect.result(fileSystem.readFileString(path));
	if (Result.isFailure(source)) {
		const reason = source.failure.reason._tag;
		if (reason !== "NotFound") state.errors.push(`${path}: cannot be read: ${reason}`);
		return;
	}
	const document = Jsonc.parse(source.success);
	if ("error" in document) {
		state.errors.push(`${path}: ${document.error}`);
		return;
	}
	const parsed = document.value;
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		state.errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	const { servers, errors: problems } = state;
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		if (scope === "project" && isRecord(value) && isOverride(value)) {
			const base = servers.get(name);
			const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
			if (!base) problems.push(`${path}: server "${name}" needs "command" or "url", or a user server to override`);
			else if (extra.length > 0)
				problems.push(`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
			else {
				const config = validate(name, { ...base.config, ...value });
				if (Predicate.isString(config)) problems.push(`${path}: ${config}`);
				else servers.set(name, { ...base, config, override: path });
			}
			continue;
		}
		const config = validate(name, value);
		if (Predicate.isString(config)) {
			problems.push(`${path}: ${config}`);
			continue;
		}
		const other = clash(servers.keys(), name);
		if (other !== undefined) {
			problems.push(`${path}: server "${name}" conflicts with "${other}"`);
			continue;
		}
		servers.set(name, { name, config, file: path });
	}
});

/**
 * Both layers. `userDir` is where the user `settings.jsonc` is read from; `root` is the session's
 * project root, absent for a session with none.
 */
export const load = Effect.fn("Mcp.loadConfig")(function* (input: {
	readonly userDir: string;
	readonly root?: string | undefined;
}) {
	const state: State = { servers: new Map(), errors: [] };
	yield* read(hostPath.join(input.userDir, "mcp.json"), "user", state);
	if (input.root !== undefined)
		yield* read(hostPath.join(input.root, Global.appConfigDir, "mcp.json"), "project", state);
	return { servers: [...state.servers.values()], errors: state.errors } satisfies McpSettings;
});

export * as McpConfig from "./config.ts";
