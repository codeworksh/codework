import type { ServerConfig } from "@codeworksh/plugin/plugin/mcp";
import { Cause, Effect, Schema } from "effect";
import type { Mcp } from "../mcp/mcp.ts";
import type { Prepared } from "./catalog.ts";
import type { SharedPluginContext } from "./context.ts";
import type { Selection } from "../tool/registry.ts";
import { rank } from "./plugin.ts";
import { make } from "./registry.ts";

export class SetupError extends Schema.TaggedError<SetupError>()("Plugin.SetupError", {
	pluginId: Schema.optional(Schema.String),
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

export const run = Effect.fn("PluginHost.run")(function* (
	selection: ReadonlyArray<Prepared>,
	input: Omit<SharedPluginContext, "plugin">,
	/** The MCP servers the `mcp` domain settled on; their tools are added before the `tool` domain runs. */
	mcp: (servers: ReadonlyArray<readonly [string, ServerConfig]>) => Effect.Effect<Mcp.Reconciled>,
	tools?: Selection,
) {
	const buckets = make(input.settings.mcp.servers);
	const ctx = Object.freeze({ ...input, plugin: buckets.registry });
	let reconciled: Mcp.Reconciled | undefined;
	const settle = Effect.gen(function* () {
		if (reconciled !== undefined) return reconciled;
		reconciled = yield* mcp(buckets.settle());
		for (const tool of reconciled.tools) buckets.registry.tools.add(tool);
		return reconciled;
	});
	/**
	 * `whenDeferred` plugins wait for the end of their domain, when every tool of it is registered,
	 * and run only if one of those is deferred or an MCP server may still add one.
	 */
	let waiting = selection.filter((prepared) => prepared.whenDeferred === true);
	const flush = (before: number) =>
		Effect.gen(function* () {
			const due = waiting.filter(({ plugin }) => rank(plugin.kind) < before);
			if (due.length === 0) return;
			waiting = waiting.filter((prepared) => !due.includes(prepared));
			const { connecting } = yield* settle;
			if (connecting || buckets.registry.tools.list().some((def) => def.exposure === "deferred"))
				for (const prepared of due) yield* apply(prepared);
		});
	const apply = ({ plugin, options }: Prepared) =>
		Effect.gen(function* () {
			if (plugin.kind !== "mcp") yield* settle;
			yield* Effect.suspend(() => {
				const result = plugin.setup(ctx, options);
				if (Effect.isEffect(result))
					// Plugin authors may fail with domain-specific errors; normalize them at this boundary.
					// @effect-diagnostics-next-line anyUnknownInErrorContext:off
					return result.pipe(
						Effect.mapError(
							(cause) =>
								new SetupError({ pluginId: plugin.id, message: `plugin setup failed: ${plugin.id}`, cause }),
						),
					);
				if (result === undefined) return Effect.void;
				return Effect.tryPromise({
					try: () => result,
					catch: (cause) =>
						new SetupError({ pluginId: plugin.id, message: `plugin setup failed: ${plugin.id}`, cause }),
				});
			}).pipe(
				Effect.catchCause((cause) => {
					if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
					// Typed failures are already SetupErrors; wrap only defects (sync throws, dies)
					// so the original plugin error is never nested twice. `Schema.is` on a tagged
					// error class matches any Error carrying the same `_tag` and fields -- another
					// class with this tag passes, while a plain object does not, lacking the Error
					// prototype -- so a plugin throwing a bare `{ _tag: "Plugin.SetupError" }` is
					// wrapped and attributed here like any other defect.
					const squashed = Cause.squash(cause);
					return Effect.fail(
						Schema.is(SetupError)(squashed)
							? squashed
							: new SetupError({
									pluginId: plugin.id,
									message: `plugin setup failed: ${plugin.id}`,
									cause: squashed,
								}),
					);
				}),
			);
		});
	const setup = Effect.gen(function* () {
		for (const prepared of selection) {
			if (prepared.whenDeferred) continue;
			yield* flush(rank(prepared.plugin.kind));
			yield* apply(prepared);
		}
		yield* flush(Infinity);
		const { deferred } = yield* settle;
		return yield* Effect.try({
			try: () => buckets.freeze(input.location.directory, tools, deferred),
			catch: (cause) =>
				new SetupError({
					message: `plugin snapshot freeze failed: ${cause instanceof Error ? cause.message : String(cause)}`,
					cause,
				}),
		});
	});
	return yield* setup.pipe(Effect.ensuring(Effect.sync(buckets.close)));
});
