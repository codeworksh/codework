import { Cause, Effect, Schema } from "effect";
import type { SharedPluginContext } from "./context.ts";
import type { Plugin } from "./plugin.ts";
import { make } from "./registry.ts";

export class SetupError extends Schema.TaggedError<SetupError>()("Plugin.SetupError", {
	pluginId: Schema.optional(Schema.String),
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

export const run = Effect.fn("PluginHost.run")(function* (
	plugins: ReadonlyArray<Plugin>,
	input: Omit<SharedPluginContext, "plugin">,
) {
	const buckets = make();
	const ctx = Object.freeze({ ...input, plugin: buckets.registry });
	const setup = Effect.gen(function* () {
		for (const plugin of plugins) {
			yield* Effect.suspend(() => {
				const result = plugin.setup(ctx);
				if (Effect.isEffect(result))
					// Plugin authors may fail with domain-specific errors; normalize them at this boundary.
					// @effect-diagnostics-next-line anyUnknownInErrorContext:off
					return result.pipe(
						Effect.mapError(
							(cause) =>
								new SetupError({ pluginId: plugin.id, message: `Plugin setup failed: ${plugin.id}`, cause }),
						),
					);
				if (result === undefined) return Effect.void;
				return Effect.tryPromise({
					try: () => result,
					catch: (cause) =>
						new SetupError({ pluginId: plugin.id, message: `Plugin setup failed: ${plugin.id}`, cause }),
				});
			}).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterrupts(cause)
						? Effect.failCause(cause)
						: Effect.fail(
								new SetupError({
									pluginId: plugin.id,
									message: `Plugin setup failed: ${plugin.id}`,
									cause: Cause.squash(cause),
								}),
							),
				),
			);
		}
		return yield* Effect.try({
			try: buckets.freeze,
			catch: (cause) => new SetupError({ message: "Plugin snapshot freeze failed", cause }),
		});
	});
	return yield* setup.pipe(Effect.ensuring(Effect.sync(buckets.close)));
});
