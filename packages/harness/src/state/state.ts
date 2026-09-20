/*
 * @file Runtime state snapshot for one exchange.
 *
 * State.Snapshot answers "what is this agent, right now": its system prompt, its tool
 * set, and the provider options a request is built from. It is captured once per
 * exchange and pinned for every turn inside it, so a turn's continuations all
 * see the same prompt and the same tools.
 *
 * State.Snapshot should read the mount; it never acquires one. `snapshot` therefore declares
 * `SandboxIO.Provides | Location.Service` in its requirements, which makes
 * "mount first" a type-level fact: the method cannot be called outside a session
 * drain.
 */

import type { Model, Protocol } from "@codeworksh/aikit";
import { Context, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect";
import { Event } from "../event/event.ts";
import { EventList } from "../event/list.ts";
import { EventRegistry } from "../event/registry.ts";
import { makeEvents, type PromptResolver } from "../plugin/context.ts";
import { run as setup } from "../plugin/host.ts";
import { select, type Origin, type Pool, type PluginRef } from "../plugin/catalog.ts";
import { LLM } from "../runner/llm.ts";
import type { Runner } from "../runner/run.ts";
import { Location } from "../location/location.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { SessionRuntime } from "../session/runtime.ts";
import type { ID as SessionId } from "../session/schema.ts";
import { Session as SessionStore } from "../session/session.ts";
import { merge } from "../settings/merge.ts";
import { compose, resolveOptions } from "../settings/resolve.ts";
import type { Block, Info } from "../settings/schema.ts";
import { Settings } from "../settings/settings.ts";
import type { Resolved } from "../tool/registry.ts";

/**
 * How a turn's tool calls are scheduled once the array has been re-read.
 *
 * Pinned in the snapshot so a configuration change cannot switch scheduling
 * halfway through an exchange. State supplies the value; Loop implements it.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Everything a caller may legally inject into aikit's
 * `stream(model, context, options)`.
 *
 * aikit's bag is generic per protocol (`Protocol.OptionsFor<TProtocol>`); this is
 * the erased form, the same move the tool registry makes when it discharges a
 * tool's capability `R`. Four fields are excluded:
 *
 * - `signal` -- `LLM.run` binds it to the scope that aborts the transport on
 *   interruption. A caller value would silently break cancellation.
 * - `sessionId` -- Loop owns it.
 * - `reasoning` -- this *is* the thinking level. Exposing it alongside
 *   `thinkingLevel` would be two spellings of one value, free to drift.
 * - `modelId` -- duplicates {@link Options.model}.
 *
 * Note: keep options in sync with aikit see @codeworksh/aikit
 */
export type RequestOptions = Omit<Protocol.CommonOptions, "signal" | "sessionId" | "reasoning"> & {
	readonly baseURL?: string;
	readonly method?: Model.APIMethodEnum;
	readonly toolChoice?: unknown;
	readonly activeTools?: ReadonlyArray<string>;
	readonly factoryOptions?: Record<string, unknown>;
	readonly providerOptions?: Record<string, Record<string, unknown>>;
};

export interface Options extends RequestOptions {
	/** Optional caller inputs interpreted by prompt plugins. */
	readonly promptCustom?: string | PromptResolver;
	readonly promptSystemAppend?: string | PromptResolver;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: Model.ThinkingLevel;
	readonly toolExecution?: ToolExecutionMode;
}

/**
 * Exchange plugin setup failed.
 *
 * Typed rather than a defect: a caller's callback failing is a caller bug, but it
 * is one the session should report and survive rather than crash on. The turn
 * fails before any provider request goes out.
 */
export class SnapshotError extends Schema.TaggedError<SnapshotError>()("State.SnapshotError", {
	sessionId: Schema.String,
	reason: Schema.String,
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return this.reason;
	}
}

/**
 * Immutable runtime state for one exchange.
 *
 * `tools.handle` is executable, and that is deliberate: the definitions the model
 * is shown, the wire schemas it is given, and the handlers that run all come from
 * one resolved registry. Splitting them would let the advertised set drift from
 * the executed one.
 *
 * Not durable and not serializable. It holds no mutable refs and owns no
 * lifecycle -- the mount it reads outlives it.
 */
export interface Snapshot {
	readonly sessionId: SessionId;
	readonly sandbox: SandboxIO.Identity;
	readonly location: Location.Info;
	readonly systemPrompt: string;
	readonly tools: Resolved;
	readonly provider: string;
	readonly model: string;
	readonly resolvedModel: Model.Info;
	readonly thinkingLevel: Model.ThinkingLevel;
	readonly request: RequestOptions;
	/** Matched file attributes used to construct provider requests. */
	readonly settings: Block;
	readonly toolExecution: ToolExecutionMode;
}

export interface Reloaded {
	/** How many plugins the new set holds, when it swapped. */
	readonly plugins: number;
	/** Why the swap did not happen. The previous set is still the one in use. */
	readonly failure?: string;
}

export interface Interface {
	/**
	 * Re-import every configured plugin, and swap the loaded set if it works.
	 *
	 * This covers exactly one case the exchange boundary cannot: a **local** plugin whose contents
	 * changed while its path did not. Nothing in settings changed and no generation moved -- there
	 * is none, because a local source is never copied into the store -- so neither boundary check
	 * fires, and the module registry holds the old module against an unchanged URL.
	 *
	 * Which settles what reload *is*: not a way to reach the store, but a way to say "re-import
	 * even though nothing looks different". The store is reached by `install` and `update`.
	 *
	 * **A failure here is not fatal**, deliberately unlike boot. At boot a broken plugin entry
	 * fails fast, matching the settings loader. At reload the last good set stays and the failure
	 * is reported: a long-running server that empties its tool registry because someone typo'd a
	 * settings file is worse than one that keeps working and says so.
	 *
	 * A reload lands at the next exchange, never inside one, because `snapshot` reads the loaded
	 * set once at its top.
	 */
	readonly reload: Effect.Effect<Reloaded>;
	/**
	 * Capture runtime state for one exchange. Called inside a session drain,
	 * where the mount it reads is already open.
	 */
	readonly snapshot: (
		sessionId: SessionId,
	) => Effect.Effect<
		Snapshot,
		| SnapshotError
		| Settings.SettingsError
		| Runner.ModelCatalogError
		| Runner.ModelNotFoundError
		| Runner.ProviderError,
		SandboxIO.Provides | Location.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/state/state/Service") {}

const resolver = (input: string | PromptResolver): PromptResolver => (typeof input === "string" ? () => input : input);

/**
 * `pool` is the loaded module set, behind a `Ref` rather than a frozen array.
 *
 * The split it enables: **loading** a module costs a store lookup and an ESM import, so it happens
 * at boot and at `reload`; **configuring** one -- `enabled`, `options`, order -- is pure data over
 * modules already in memory, so it happens at every exchange. That is why editing `options` in a
 * settings file takes effect at the next turn without anything being re-imported.
 *
 * `snapshot` reads the `Ref` once, at the top, so a reload lands on the next exchange and never
 * mid-turn. Combined with generations, a reload that brings new bytes for a loaded plugin imports
 * a genuinely different URL, so the module registry cannot hand back the old one.
 *
 * `references` says which entries the config pass walks. It is a function of the settings that
 * exchange read, so a caller that pinned an explicit list keeps it and everyone else follows the
 * files.
 */
export const layer = (
	options: Options,
	pool: Ref.Ref<Pool>,
	references: (settings: Info) => ReadonlyArray<PluginRef>,
	/**
	 * The exchange-boundary check: the new pool when the store has moved, nothing when it has not.
	 * State does not know what a store is, so whoever built the pool answers this.
	 */
	follow: (
		refs: ReadonlyArray<PluginRef>,
		current: Pool,
		settings: Info,
	) => Effect.Effect<Option.Option<Pool>, { readonly message: string }>,
	/**
	 * A full load pass, told to re-import even where nothing looks different. Resolve-only, like
	 * `follow`: reload re-imports what is on disk, it does not fetch.
	 *
	 * It takes no references and reads its own settings, because the set it must produce is the
	 * *process's* -- every module any session might name -- and State only ever sees one session's
	 * view. Handing it `references` from here would quietly narrow the pool to whatever the
	 * caller's project declares, and drop every other project's plugins on the floor.
	 */
	rebuild: () => Effect.Effect<Pool, { readonly message: string }>,
) => {
	return Layer.effect(
		Service,
		Effect.gen(function* () {
			const runtime = yield* SessionRuntime.Service;
			const sessions = yield* SessionStore.Service;
			const settings = yield* Settings.Service;
			const eventRegistry = yield* EventRegistry.Service;
			const eventService = yield* Event.Service;
			const events = makeEvents(eventService);
			/*
			 * One load pass at a time, for the whole process.
			 *
			 * Two sessions can reach an exchange boundary together and both find the same entry
			 * unloaded -- someone ran `plugin add` in a directory they share. Without this they
			 * both run a load pass and both swap the pool, so the work happens twice and the
			 * loser's result is discarded.
			 *
			 * Deliberately *not* the cross-process filesystem lock of the store: that one answers
			 * "two machines installing", this one answers "two fibers importing". It belongs to
			 * the load pass, and it is cheap because it is only ever taken when something moved.
			 */
			const loading = yield* Semaphore.make(1);
			const updated = (origin: Origin, id: string, status: "loaded" | "dropped") =>
				eventService.publish(EventList.PluginUpdated, {
					status,
					reference: origin.reference,
					id,
					...(origin.file === undefined ? {} : { file: origin.file }),
				});
			const activate = Effect.fn("State.activatePlugins")(function* (next: Pool) {
				const previous = yield* Ref.get(pool);
				// Validation and the pool swap are one uninterruptible operation: a bad event definition
				// never becomes runnable, and the registry cannot describe a different pool than State holds.
				yield* eventRegistry.replace([...next.plugins.values()]);
				yield* Ref.set(pool, next);
				// One ephemeral notice per transition, published only after the swap lands so a
				// listener always reads the pool the notice describes. A changed module instance is
				// the load signal: it covers a new plugin, a superseding generation, and a
				// re-imported local file alike.
				for (const [id, origin] of next.origins) {
					if (next.plugins.get(id) === previous.plugins.get(id)) continue;
					yield* updated(origin, id, "loaded");
				}
				for (const [id, origin] of previous.origins) {
					if (next.origins.has(id)) continue;
					yield* updated(origin, id, "dropped");
				}
				return next;
			}, Effect.uninterruptible);
			// The boot set goes through the same shape; ephemeral means only a listener already
			// attached sees it.
			for (const [id, origin] of (yield* Ref.get(pool)).origins) {
				yield* updated(origin, id, "loaded");
			}
			const publishFailed = (cause: { readonly message: string }) =>
				eventService.publish(EventList.PluginUpdated, {
					status: "failed",
					error: cause.message,
					...("reference" in cause && typeof cause.reference === "string" ? { reference: cause.reference } : {}),
				});
			return Service.of({
				reload: Effect.gen(function* () {
					// Swaps the module set for the whole process. Which of those a given session
					// runs stays that session's own question, answered by its config pass at the
					// next exchange.
					const rebuilt = yield* rebuild().pipe(Effect.flatMap(activate), loading.withPermits(1), Effect.result);
					if (rebuilt._tag === "Failure") {
						yield* Effect.logWarning(
							`plugin reload failed, keeping the previous set: ${rebuilt.failure.message}`,
						);
						yield* publishFailed(rebuilt.failure);
						return { plugins: (yield* Ref.get(pool)).plugins.size, failure: rebuilt.failure.message };
					}
					return { plugins: rebuilt.success.plugins.size };
				}),
				snapshot: Effect.fn("State.snapshot")(function* (sessionId: SessionId) {
					const sessionOptions = Option.getOrElse(yield* runtime.get(sessionId), () => ({}));
					// Read per exchange, not captured at creation, so `Session.link` takes effect at
					// the next one. A session with none discovers no project layer: there is no
					// fallback to the process's directory, which would hand it a stranger's project
					// (it is a long-running server; one process serves sessions in many projects, or
					// in none).
					const session = yield* sessions.get(sessionId);
					const hostDir = Option.isNone(session) ? undefined : Option.getOrUndefined(session.value.hostDir);
					// Not wrapped: a file the user can fix is more useful to a client as a settings
					// failure carrying its path and key than as an anonymous snapshot failure.
					const loadedSettings = yield* settings.load(hostDir);
					const configured = compose(loadedSettings, options, sessionOptions);
					const {
						promptCustom,
						promptSystemAppend,
						provider: _provider,
						model: _model,
						thinkingLevel: _thinkingLevel,
						toolExecution: _toolExecution,
						...rest
					} = configured.runtime;
					const { provider, model, thinkingLevel, toolExecution } = configured;
					const request = merge(resolveOptions(configured.block), rest);
					const sandbox = yield* SandboxIO.Current;
					const location = yield* Location.Service;

					const resolvedModel = yield* LLM.resolve({ provider, model, settings: configured.block });

					const refs = references(loadedSettings);
					const failed = (cause: { readonly message: string }) =>
						new SnapshotError({ sessionId, reason: cause.message, cause });

					// Follow the store: load an entry whose bytes are already here, and move to a
					// newer generation of one that is. Never a fetch -- `plugin install` stays the
					// verb that puts bytes on disk.
					const loaded = yield* Effect.gen(function* () {
						// Re-read inside the permit: whoever held it may have just done this exact
						// work, and adopting their result is the point.
						const current = yield* Ref.get(pool);
						const moved = yield* follow(refs, current, loadedSettings).pipe(Effect.tapError(publishFailed));
						if (Option.isNone(moved)) return current;
						return yield* activate(moved.value);
					}).pipe(loading.withPermits(1), Effect.mapError(failed));

					// The config pass: pure data over what is already loaded, so it runs every
					// exchange.
					const chosen = yield* select(refs, loaded).pipe(Effect.mapError(failed));
					// An entry naming a module the pool does not hold is the one case the pass
					// cannot satisfy, so it is free to report -- which is what a watcher was
					// buying, minus the watcher. Reported once per snapshot that finds it.
					for (const reference of chosen.missing) {
						// Naming the file is most of the value: with several layers accumulating
						// entries, "which one of my settings files says this" is the question.
						const where = loadedSettings.declared.find((one) =>
							typeof one.entry === "string"
								? one.entry === reference
								: "package" in one.entry && one.entry.package === reference,
						);
						yield* Effect.logWarning(
							`plugin ${reference} is configured but not loaded — run \`codework plugin install\`${
								where === undefined ? "" : ` (declared in ${where.file})`
							}`,
						);
					}

					const contributions = yield* setup(chosen.selection, {
						sessionId,
						sandbox,
						location,
						settings: loadedSettings,
						model: resolvedModel,
						events,
						config: {
							...(promptCustom === undefined ? {} : { promptCustom: resolver(promptCustom) }),
							...(promptSystemAppend === undefined ? {} : { promptSystemAppend: resolver(promptSystemAppend) }),
						},
					}).pipe(Effect.mapError((cause) => new SnapshotError({ sessionId, reason: cause.message, cause })));

					return {
						sessionId,
						sandbox,
						location,
						...contributions,
						provider,
						model,
						resolvedModel,
						thinkingLevel,
						request,
						settings: configured.block,
						toolExecution,
					} satisfies Snapshot;
				}),
			});
		}),
	);
};

export * as State from "./state.ts";
