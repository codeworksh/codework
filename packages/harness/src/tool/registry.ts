import type { ToolRegistration } from "../plugin/tool/schema.ts";
import type { Message } from "@codeworksh/aikit";
import { Context, Layer } from "effect";
import * as Executor from "./executor.ts";
import { type AnyToolDef, declared, type RegisteredTool, toAikitTool } from "./tool.ts";

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

/**
 * A thread's choice of offered tools (its `agent` document's `modelTools`): `add` loads deferred
 * tools, in load order; `remove` withholds tools, declared or loaded.
 */
export interface Selection {
	readonly add?: ReadonlyArray<string> | undefined;
	readonly remove?: ReadonlyArray<string> | undefined;
}

/** A frozen effective tool set: model-facing defs + the single execution entry point. */
export interface Resolved {
	/** Definitions of the offered tools: the declared ones, then loaded deferred ones in load order. */
	readonly defs: ReadonlyArray<AnyToolDef>;
	/**
	 * The declared tools' wire view, handed to the LLM request as `tools`. Loaded tools never join
	 * it: they reach the model as transcript system messages, so loading one keeps the request prefix.
	 */
	readonly wire: ReadonlyArray<Message.Tool>;
	/** The offered tools' wire view: the tool state the transcript's system messages bring `wire` to. */
	readonly offered: ReadonlyArray<Message.Tool>;
	/** Deferred tools not offered, in registry order: what `toolsearch` searches. */
	readonly deferred: ReadonlyArray<Message.Tool>;
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
	/** Metadata listing (name / description / …) of every registered tool, whatever its exposure. */
	readonly defs: ReadonlyArray<AnyToolDef>;
	readonly names: ReadonlyArray<string>;
	/** Metadata lookup only — never exposes the executable impl. */
	readonly getDef: (name: string) => AnyToolDef | undefined;
	/** Resolve a frozen snapshot of the tools offered to the model under `selection`. */
	readonly resolve: (selection?: Selection) => Resolved;
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
export const make = (tools: ReadonlyArray<RegisteredTool | ToolRegistration>): Registry => {
	const byName = new Map<string, ToolRegistration>();
	for (const item of tools) {
		const entry = "tool" in item ? item : { tool: item, hooks: {} };
		byName.set(entry.tool.definition.name, entry);
	}

	// Capture the effective set ONCE; every snapshot closes over these frozen arrays, so it
	// keeps its winning implementations and membership regardless of any later change.
	const effective = Object.freeze([...byName.values()]);
	const defs = Object.freeze(effective.map((entry) => entry.tool.definition));
	const names = Object.freeze(effective.map((entry) => entry.tool.definition.name));
	const isDeferred = (entry: ToolRegistration) => entry.tool.definition.exposure === "deferred";

	const resolve = (selection?: Selection): Resolved => {
		const removed = new Set(selection?.remove);
		const declaredSet = effective.filter((entry) => declared(entry.tool.definition));
		const kept = declaredSet.filter((entry) => !removed.has(entry.tool.definition.name));
		const loaded = [...new Set(selection?.add)].flatMap((name) => {
			const entry = byName.get(name);
			return entry !== undefined && isDeferred(entry) && !removed.has(name) ? [entry] : [];
		});
		const offered = [...kept, ...loaded];
		const deferred = Object.freeze(
			effective
				.filter((entry) => isDeferred(entry) && !offered.includes(entry))
				.map((entry) => toAikitTool(entry.tool.definition)),
		);
		// Only offered tools run: a call to another registered one gets `ToolUnavailable`.
		const executor = Executor.make(offered, { registered: names, deferred });
		return Object.freeze({
			defs: Object.freeze(offered.map((entry) => entry.tool.definition)),
			wire: Object.freeze(declaredSet.map((entry) => toAikitTool(entry.tool.definition))),
			offered: Object.freeze([...executor.wire]),
			deferred,
			handle: executor.handle,
		});
	};

	return Object.freeze({
		defs,
		names,
		getDef: (name: string) => byName.get(name)?.tool.definition,
		resolve,
	});
};

/**
 * `ToolRegistry` — the registry as an Effect service, for a loop assembled as a `Layer.effect`
 * that does `yield* ToolRegistry`. The service value is the non-generic {@link Registry} (tool
 * `R` is discharged at registration), so there is no capability union to fix here.
 */
export class ToolRegistry extends Context.Service<ToolRegistry, Registry>()(
	"@codeworksh/harness/tool/registry/ToolRegistry",
) {}

/** Provide a catalog of registered tools as the {@link ToolRegistry} service. */
export const layer = (tools: ReadonlyArray<RegisteredTool | ToolRegistration>): Layer.Layer<ToolRegistry> =>
	Layer.succeed(ToolRegistry, ToolRegistry.of(make(tools)));
