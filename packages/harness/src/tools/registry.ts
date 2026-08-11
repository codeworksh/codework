import type { Message } from "@codeworksh/aikit";
import { Context, Layer } from "effect";
import * as Executor from "./executor.ts";
import type { AnyToolDef, RegisteredTool } from "./tool.ts";

/**
 * `ToolRegistry` — the loop-facing entry point to the tool catalog
 *
 * A `Registry` is a plain immutable value (like {@link Executor}, not a service): a catalog
 * of {@link RegisteredTool}s plus a `resolve` that produces a frozen {@link Resolved}
 * snapshot. The registry **catalogs** tools and produces snapshots; it does **not** execute
 * them — execution lives on the resolved snapshot (`resolved.handle`), backed by the
 * `Executor`.
 *
 * Because a tool's capability `R` is discharged at registration (`Tool.provide` → a
 * `RegisteredTool` whose only residual requirement is the executor-provided `ToolProgress`),
 * `Registry` / `Resolved` are **non-generic** — so any number of tools (built-in or
 * third-party/plugin) compose without a shared capability union.
 */

/** A frozen effective tool set: model-facing defs + the single execution entry point. */
export interface Resolved {
	/** Pure definition data (prompt index, debugging, future codemode). */
	readonly defs: ReadonlyArray<AnyToolDef>;
	/** The aikit wire view handed to the LLM request as `tools`. */
	readonly wire: ReadonlyArray<Message.Tool>;
	/**
	 * Transform one complete pending tool-call part into a complete terminal part. The **only**
	 * execution entry point — the
	 * loop never runs a tool any other way. This is the executor's `handle` re-exposed; because
	 * the catalog holds `RegisteredTool`s (capability `R` discharged), only a progress sink's own
	 * `RProgress` surfaces in the result.
	 */
	readonly handle: Executor.Executor["handle"];
}

/** The catalog: an immutable set of registered tools + a resolver. A plain list of tools. */
export interface Registry {
	/** Metadata listing (name / description / …). */
	readonly defs: ReadonlyArray<AnyToolDef>;
	readonly names: ReadonlyArray<string>;
	/** Metadata lookup only — never exposes the executable impl. */
	readonly getDef: (name: string) => AnyToolDef | undefined;
	/** Resolve a frozen snapshot of the effective tool set. */
	readonly resolve: () => Resolved;
}

/**
 * Build a registry from a list of registered tools.
 *
 * Duplicate names are resolved by **last-registered-wins override**: a later registration
 * replaces the implementation bound to a name (e.g. a plugin's bash over the built-in).
 * `Map.set` updates the value in place, so `defs` / `wire` / `names` keep **first-seen**
 * order — only the bound implementation changes. Override resolution happens here, before
 * `Executor.make`, which requires unique effective names.
 */
export const make = (tools: ReadonlyArray<RegisteredTool>): Registry => {
	const byName = new Map<string, RegisteredTool>();
	for (const tool of tools) byName.set(tool.definition.name, tool);

	// Capture the effective set ONCE; the snapshot closes over these frozen arrays, so it
	// keeps its winning implementations and membership regardless of any later change.
	const effective = Object.freeze([...byName.values()]);
	const defs = Object.freeze(effective.map((tool) => tool.definition));
	const names = Object.freeze(effective.map((tool) => tool.definition.name));

	// The effective set is unique, so the executor's own duplicate guard never trips.
	const executor = Executor.make(effective);

	const resolved: Resolved = Object.freeze({
		defs,
		wire: Object.freeze([...executor.wire]),
		handle: executor.handle,
	});

	return Object.freeze({
		defs,
		names,
		getDef: (name: string) => byName.get(name)?.definition,
		resolve: () => resolved,
	});
};

/**
 * `ToolRegistry` — the registry as an Effect service, for a loop assembled as a `Layer.effect`
 * that does `yield* ToolRegistry`. The service value is the non-generic {@link Registry} (tool
 * `R` is discharged at registration), so there is no capability union to fix here.
 */
export class ToolRegistry extends Context.Service<ToolRegistry, Registry>()(
	"@codeworksh/harness/tools/registry/ToolRegistry",
) {}

/** Provide a catalog of registered tools as the {@link ToolRegistry} service. */
export const layer = (tools: ReadonlyArray<RegisteredTool>): Layer.Layer<ToolRegistry> =>
	Layer.succeed(ToolRegistry, ToolRegistry.of(make(tools)));
