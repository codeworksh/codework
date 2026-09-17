/*
 * A plugin whose Effect is a *different module instance* than the harness's, which is what an
 * installed third-party plugin has: the loader installs it into its own cache directory, so its
 * `effect` dependency is loaded separately even when it is the same version.
 *
 * The second instance comes from importing the very same file under a different specifier, so the
 * repository keeps exactly one Effect version and needs no alias dependency. Everything the
 * plugin touches — the generator, the service tag, the schemas, the handler — comes from that
 * second instance.
 */
import type { PluginOptions } from "../../../src/plugin/catalog.ts";
import type { SharedPluginContext } from "../../../src/plugin/context.ts";
import type { Plugin } from "../../../src/plugin/plugin.ts";
import { SandboxIO } from "../../../src/sandbox/io.ts";
import * as Tool from "../../../src/tool/tool.ts";

const foreign: typeof import("effect") = await import(`${import.meta.resolve("effect")}?foreign-instance`);
const { Effect, Schema } = foreign;

export default {
	id: "acme.tool.foreign",
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
