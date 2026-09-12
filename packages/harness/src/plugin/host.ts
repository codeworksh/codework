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
					// error class is an identity check, so a plugin throwing its own
					// SetupError-shaped object still gets attributed to it.
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
		}
		return yield* Effect.try({
			try: buckets.freeze,
			catch: (cause) =>
				new SetupError({
					message: `plugin snapshot freeze failed: ${cause instanceof Error ? cause.message : String(cause)}`,
					cause,
				}),
		});
	});
	return yield* setup.pipe(Effect.ensuring(Effect.sync(buckets.close)));
});
