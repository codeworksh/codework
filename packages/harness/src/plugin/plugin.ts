import type { Effect } from "effect";
import type { EventSchema } from "../event/schema.ts";
import type { Location } from "../location/location.ts";
import type { SandboxIO } from "../sandbox/io.ts";
import type { PluginOptions } from "./catalog.ts";
import type { SharedPluginContext } from "./context.ts";

/**
 * The domains a plugin can extend, and the order the harness runs them in.
 *
 * Order is declared, not positional. A plugin's place used to come from where its entry sat in
 * the `plugins` array, which is unknowable when the entry is written: a user's settings file and
 * a project's are edited by different people at different times, and neither can see the other's
 * order. Since a prompt plugin indexes the tools registered before it, that made a tool added
 * from settings invisible in the system prompt, with no way to fix it from a settings file.
 *
 * A plugin instead says which domain it extends, and the harness runs the domains in this order.
 * Entries within one domain keep the order they were written in, because that is where
 * composition actually happens -- a plugin patching another's tool, or appending to the prompt a
 * previous one rendered, is written next to it and deliberately after it.
 *
 * Kept as data so a later release can add a domain, or make the order configurable, without
 * touching the loader: `{ tool: 1, skill: 2, prompt: 3 }` needs no code change here.
 */
export const domains = { tool: 1, prompt: 2 } as const;

export type PluginKind = keyof typeof domains;

/** Sort key for a plugin: its domain first, then where it was written. */
export const rank = (kind: PluginKind) => domains[kind];

export type Mount = SandboxIO.Provides | Location.Service;
export interface Plugin {
	readonly id: string;
	/**
	 * The domain this plugin extends, which decides when it runs: every `tool` plugin is set up
	 * before any `prompt` plugin, whichever settings layer each came from, so a prompt plugin
	 * always sees the complete tool set. Plugins within one domain run in the order they were
	 * written.
	 */
	readonly kind: PluginKind;
	/**
	 * Event definitions this plugin publishes. Declared rather than registered at
	 * runtime so they are known before the event system builds, and so a bad type
	 * fails the boot instead of the first publish. Types must be namespaced
	 * `plugin.<id>.*`.
	 */
	readonly events?: ReadonlyArray<EventSchema.Definition>;
	/**
	 * `options` is this plugin's own configuration block, `{}` when its entry carried none.
	 * Unvalidated: the harness never looks inside it, so a plugin checks whatever shape it
	 * documents. It is a second argument rather than a context field so `ctx` stays one object
	 * shared by every plugin in the exchange.
	 */
	readonly setup: (
		ctx: SharedPluginContext,
		options: PluginOptions,
	) => void | Promise<void> | Effect.Effect<void, unknown, Mount>;
}

export const define = (plugin: Plugin): Plugin => plugin;
