/**
 * `@codeworksh/plugin` — the SDK for building CodeWork plugins.
 *
 * A plugin is a module that default-exports one {@link Plugin.define} object. It registers tools,
 * composes the system prompt, and reads the session's location, model and settings off a context
 * the harness hands it. This package is exactly that contract: the harness depends on it too, so
 * a plugin compiled against these types is the same plugin the harness loads.
 *
 * ```ts
 * import { Plugin, Tool } from "@codeworksh/plugin";
 * import { Effect, Schema } from "effect";
 *
 * export default Plugin.define({
 *   id: "acme.tool.echo",
 *   kind: "tool",
 *   setup(ctx) {
 *     ctx.plugin.tools.add(
 *       Tool.register(
 *         Tool.make({
 *           name: "echo",
 *           description: "Echo a message back.",
 *           parameters: Schema.Struct({ message: Schema.String }),
 *           success: Schema.Struct({ message: Schema.String }),
 *           handler: ({ message }) => Effect.succeed({ message }),
 *         }),
 *       ),
 *     );
 *   },
 * });
 * ```
 *
 * The sandbox mount a tool runs against lives in `@codeworksh/plugin/sandbox`.
 *
 * The remaining subpaths -- `./event`, `./ids`, `./location`, `./settings`, `./schema` and the
 * rest -- exist because the harness imports them across the package boundary, not because they
 * are an authoring surface. Nothing here re-exports them: a plugin that turns out to need one
 * imports that subpath directly, and adding it to this entry is a decision for whoever has that
 * use, not for this file to guess at.
 */
export * as Plugin from "./plugin.ts";
export * as Tool from "./tool.ts";
