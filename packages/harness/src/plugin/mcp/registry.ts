import type { McpRegistry, ServerConfig, ServerPatch } from "@codeworksh/plugin/plugin/mcp";
import type { McpServer } from "@codeworksh/plugin/settings";
import { Predicate } from "effect";
import { McpConfig } from "../../mcp/config.ts";

const PATCH_KEYS: ReadonlyArray<string> = ["enabled", "exposure", "toolExposure", "timeout", "description"];

/** A copy no one else holds, frozen all the way down, so a settled server cannot change behind the service. */
const frozen = <A>(value: A): A => {
	const freeze = (node: unknown) => {
		if (!Predicate.isObject(node) || Object.isFrozen(node)) return;
		for (const child of Object.values(node)) freeze(child);
		Object.freeze(node);
	};
	const copy = structuredClone(value);
	freeze(copy);
	return copy;
};

/**
 * The session's MCP servers for one turn, seeded from `mcp.json`. A plugin written in plain
 * JavaScript can hand in anything, so every write is checked here with the rules `mcp.json` follows,
 * and a bad one fails that plugin's `setup` rather than a connection later.
 */
export const make = (seed: ReadonlyArray<McpServer>) => {
	let open = true;
	const servers = new Map<string, ServerConfig>(seed.map((server) => [server.name, frozen(server.config)]));
	const writable = () => {
		if (!open) throw new Error("mcp registry is closed: servers are settled before the tool domain runs");
	};
	const checked = (name: string, config: unknown) => {
		const result = McpConfig.validate(name, config);
		if (Predicate.isString(result)) throw new Error(result);
		return frozen(result);
	};
	const registry: McpRegistry = Object.freeze({
		list: () => Object.freeze([...servers].map((entry) => Object.freeze(entry))),
		get: (name: string) => servers.get(name),
		set: (name: string, config: ServerConfig) => {
			writable();
			const other = McpConfig.clash(servers.keys(), name);
			if (other !== undefined) throw new Error(`MCP server "${name}" conflicts with "${other}"`);
			servers.set(name, checked(name, config));
		},
		update: (name: string, patch: ServerPatch) => {
			writable();
			const current = servers.get(name);
			if (current === undefined) throw new Error(`Unknown MCP server: ${name}`);
			const extra = Predicate.isObject(patch) ? Object.keys(patch).filter((key) => !PATCH_KEYS.includes(key)) : [];
			if (extra.length > 0)
				throw new Error(
					`MCP server "${name}": an update can only set ${PATCH_KEYS.join(", ")}; use set to replace it`,
				);
			servers.set(name, checked(name, { ...current, ...patch }));
		},
		remove: (name: string) => {
			writable();
			servers.delete(name);
		},
	});
	return {
		registry,
		/** Close the bucket and return the servers it settled on. */
		settle: () => {
			open = false;
			return Object.freeze([...servers]);
		},
	};
};
