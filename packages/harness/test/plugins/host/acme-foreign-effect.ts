/*
 * A plugin whose Effect is a *different module instance* than the harness's, which is what an
 * installed third-party plugin has: the loader installs it into its own cache directory, so its
 * `effect` dependency is loaded separately even when it is the same version.
 *
 * The second instance comes from re-importing the very same files under a tagged URL, so the
 * repository keeps exactly one Effect version and needs no alias dependency. Everything the
 * plugin touches — the generator, the service tag, the schemas, the handler — comes from that
 * second instance.
 *
 * The tag has to propagate through the *whole* subgraph, which is why the resolve hook exists.
 * Importing only the entry point under `?foreign-instance` is not enough and was the bug here
 * before: `effect`'s entry re-exports from submodules whose specifiers carry no query, so they
 * resolve to the modules already loaded and `foreign.Schema === Schema`. The plugin then ran on
 * the harness's own instance and proved nothing about installed plugins.
 */
import type { PluginOptions } from "../../../src/plugin/catalog.ts";
import type { SharedPluginContext } from "../../../src/plugin/context.ts";
import type { Plugin } from "../../../src/plugin/plugin.ts";
import { SandboxIO } from "../../../src/sandbox/io.ts";
import * as Tool from "../../../src/tool/tool.ts";

/** Marks the second instance's URLs. Any string works; it only has to be absent from the first. */
const TAG = "foreign-instance";

const foreign: typeof import("effect") = await (async () => {
	const { registerHooks } = await import("node:module");
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, context);
			// Only `file:` URLs: `node:fs?foreign-instance` is not a module.
			return (context.parentURL ?? "").includes(TAG) &&
				resolved.url.startsWith("file:") &&
				!resolved.url.includes(TAG)
				? { ...resolved, url: `${resolved.url}?${TAG}` }
				: resolved;
		},
	});
	try {
		return await import(`${import.meta.resolve("effect")}?${TAG}`);
	} finally {
		// The import has fully evaluated the subgraph by here, so nothing else is tagged.
		hook.deregister();
	}
})();
const { Effect, Schema } = foreign;

export default {
	id: "acme.tool.foreign",
	kind: "tool",
	// A generator created by the foreign instance, yielding a service tag built by the harness's.
	setup: Effect.fn("ForeignPlugin.setup")(function* (ctx: SharedPluginContext, options: PluginOptions) {
		const shell = yield* SandboxIO.Shell;
		// The options block is opaque, so a plugin checks it before use, as any author would.
		const marker = typeof options["marker"] === "string" ? options["marker"] : "none";
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "foreign_echo",
					description: "Echo through a plugin built against another Effect instance",
					parameters: Schema.Struct({ value: Schema.String }),
					success: Schema.String,
					encodeContent: (value: string) => [{ type: "text", text: value }],
					handler: ({ value }) =>
						Effect.succeed(`${typeof shell.exec === "function" ? "shell" : "no-shell"}:${marker}:${value}`),
				}),
			),
		);
	}),
} satisfies Plugin;
