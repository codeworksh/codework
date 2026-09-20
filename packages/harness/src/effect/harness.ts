import { Effect, Layer, Option, Ref } from "effect";
import { Context } from "../context/context.ts";
import { Control } from "../control.ts";
import { Database } from "../db/db.ts";
import { Event } from "../event/event.ts";
import { Global } from "../global.ts";
import { fileSystem } from "../host.ts";
import { EventRegistry } from "../event/registry.ts";
import { follow, load, type PluginRef, type Pool } from "../plugin/catalog.ts";
import { PluginSource } from "../plugin/source.ts";
import { PluginStore } from "../plugin/store.ts";
import { builtins } from "../plugin/builtin.ts";
import { RunnerExecute } from "../runner/execute.ts";
import { LLM } from "../runner/llm.ts";
import { Loop } from "../runner/loop.ts";
import { SandboxController } from "../sandbox/control.ts";
import { SandboxDriver } from "../sandbox/driver.ts";
import { MemorySandboxDriver } from "../sandbox/drivers/memory.ts";
import { SqldbSandboxDriver } from "../sandbox/drivers/sqldb.ts";
import { SandboxDriverLoader } from "../sandbox/loader.ts";
import { SandboxDriverRegistry } from "../sandbox/registry.ts";
import { SessionLive } from "../session/live.ts";
import { SessionRuntime } from "../session/runtime.ts";
import type { Info as SettingsInfo } from "../settings/schema.ts";
import { Settings } from "../settings/settings.ts";
import { State } from "../state/state.ts";

export interface Options {
	/**
	 * The complete selection, replacing both the built-ins and whatever `settings.plugins`
	 * asks for -- an embedder that passes this owns the plugin set, and an empty array runs
	 * none. Omit it to get the built-ins plus the settings block.
	 */
	readonly plugins?: ReadonlyArray<PluginRef>;
	readonly database?: string;
	/**
	 * The host directory the project settings layer is discovered from. Defaults to the OS
	 * process's directory; a test or an embedder that runs somewhere other than where it wants
	 * settings read from passes its own, rather than inheriting whatever launched the process.
	 */
	readonly hostCwd?: string;
	readonly home?: string;
	/** user provided directory containing the highest-priority config. */
	readonly userConfigDir?: string;
	readonly sandboxes?: ReadonlyArray<SandboxDriverLoader.Entry>;
	readonly llm?: LLM.Open;
}

export const layer = (options: Options = {}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const paths = yield* Global.resolve(options.home === undefined ? {} : { home: options.home });
			// The single sanctioned `process.cwd()` in the harness, and only as the default.
			// Everything downstream takes the host directory as a required parameter, so no module
			// can quietly fall back to the OS process's directory when it meant a session's mount.
			const hostCwd = options.hostCwd ?? process.cwd();
			const global = Global.layerWith(paths);
			const settingsOptions = options.userConfigDir === undefined ? {} : { userConfigDir: options.userConfigDir };
			// Settings are read once here because the plugin selection has to be prepared before
			// any layer that depends on it; every later read goes through `Settings.Service`,
			// which discovers from the session's own `hostDir` rather than from this one.
			//
			// This read happens before any session exists, so the process's directory is the only
			// root available -- and the right one: it is what decides which plugins this process
			// loads at all. Which of them a given session *runs* is the per-session question.
			const config = yield* Settings.load({ ...settingsOptions, home: paths.home, hostDir: hostCwd });
			/*
			 * Which entries this process configures from, per exchange.
			 *
			 * Settings entries extend the built-in selection rather than standing in for it, so
			 * naming a plugin cannot silently drop Bash or the default prompt. A built-in is turned
			 * off by name, with a `{ "plugin": "codework.tool.bash", "enabled": false }` entry.
			 *
			 * An embedder that supplied its own list keeps it verbatim: it asked for exactly this
			 * selection, and the files must not add to it behind its back.
			 */
			const references = (settings: SettingsInfo): ReadonlyArray<PluginRef> =>
				options.plugins ?? [...builtins, ...settings.plugins];

			/** Reference to the file that declared it, for failures that should name one. */
			const declaredIn = (settings: SettingsInfo): ReadonlyMap<string, string> =>
				new Map(
					settings.declared.flatMap((one) =>
						typeof one.entry === "string"
							? [[one.entry, one.file] as const]
							: "package" in one.entry
								? [[one.entry.package, one.file] as const]
								: [],
					),
				);

			const catalogOptions = { builtins, cache: paths.cache, hostDir: hostCwd };

			/*
			 * What the store already holds for a reference, and nothing else.
			 *
			 * Resolve-only by construction: `Store.resolve` never opens a socket, so an exchange
			 * asking this question cannot block on a registry, and `plugin install` stays the only
			 * verb that puts bytes on disk. A reference that does not parse, or names a local
			 * path, is simply not filed.
			 */
			type Here = Option.Option<{ readonly generation?: number }>;
			const filed = (reference: string): Effect.Effect<Here> =>
				PluginSource.parse(reference, hostCwd).pipe(
					Effect.flatMap((target): Effect.Effect<Here, unknown> =>
						target.kind === "local"
							? // On disk by definition, so it can be loaded now -- but never filed, so it
								// has no generation and can never be found superseded. That is what
								// leaves `reload` as the only way to pick up an edit to one.
								fileSystem
									.exists(target.path)
									.pipe(Effect.map((there): Here => (there ? Option.some({}) : Option.none())))
							: PluginStore.resolve(target, paths.cache).pipe(
									Effect.map((entry): Here => Option.fromUndefinedOr(entry)),
								),
					),
					Effect.orElseSucceed((): Here => Option.none()),
				);

			/*
			 * Resolve-only, everywhere the harness loads.
			 *
			 * Boot included, and that is the point: an entry whose bytes are missing is reported
			 * as `plugin-not-installed` with `codework plugin install` as the remedy, rather than
			 * silently becoming a registry round-trip on every start. Otherwise a fresh process
			 * can wait on the network, fail offline, and let network timing decide which code
			 * runs. Freshness is opt-in -- `plugin install`, `check`, `update` -- and this is what
			 * makes that true rather than aspirational.
			 */
			const resolveOnly = { ...catalogOptions, install: PluginStore.required };

			// The load pass, once, at boot: a store lookup and an ESM import per module, never a
			// fetch. Every later exchange runs only the config pass over what this produced.
			const pool = yield* Ref.make<Pool>(
				yield* load(references(config), { ...resolveOnly, declared: declaredIn(config) }),
			);
			const followStore = (refs: ReadonlyArray<PluginRef>, current: Pool, settings: SettingsInfo) =>
				follow(refs, current, { ...resolveOnly, declared: declaredIn(settings) }, filed);

			/*
			 * A reload re-imports everything, including the local plugins nothing else can notice
			 * have changed. The counter is what makes that possible: a local plugin's URL never
			 * moves, so without a query string the module registry would hand back what it already
			 * has. Resolve-only, like the boundary check -- reload re-reads disk, it never fetches.
			 */
			let reloads = 0;
			const rebuild = () =>
				Effect.gen(function* () {
					reloads += 1;
					// Re-read from the same root this process booted with, so the rebuilt pool
					// holds what the old one did plus whatever was added since.
					const current = yield* Settings.load({ ...settingsOptions, home: paths.home, hostDir: hostCwd });
					const loaded = yield* Ref.get(pool);
					// Reload is process-wide. Include modules discovered lazily from every linked
					// session, not only the project the server happened to start in.
					// The current root comes last so an edited spec replaces an older origin with
					// the same plugin ID while unrelated session plugins remain loaded.
					const accumulated = [
						...Array.from(loaded.origins.values(), (origin) => origin.reference),
						...references(current),
					];
					return yield* load(accumulated, {
						...resolveOnly,
						declared: declaredIn(current),
						reload: reloads,
					});
				});
			// Flattened before anything can publish: a plugin event type that collides
			// or is not namespaced is a boot failure, not a surprise at first publish.
			const definitions = yield* EventRegistry.flatten([...(yield* Ref.get(pool)).plugins.values()]);
			const configuredDatabase = options.database ?? (yield* Database.locationConfig);
			const database = Database.layer(Database.resolveDatabaseLocation(configuredDatabase, paths.data));
			const configured = yield* SandboxDriverLoader.loadAll(options.sandboxes ?? [], { hostCwd });
			const drivers = SandboxDriverRegistry.layer(
				SandboxDriver.withSource(MemorySandboxDriver.make().driver, "core"),
				SandboxDriver.withSource(SqldbSandboxDriver.make().driver, "core"),
				...configured,
			);
			const sandboxes = SandboxController.layer().pipe(Layer.provideMerge(drivers), Layer.provideMerge(database));
			const loop = options.llm === undefined ? Loop.layer() : Loop.layer({ request: LLM.make(options.llm) });

			return Control.layer.pipe(
				Layer.provideMerge(RunnerExecute.layer.pipe(Layer.provide(loop))),
				Layer.provideMerge(State.layer({}, pool, references, followStore, rebuild)),
				Layer.provideMerge(Settings.layer(settingsOptions)),
				Layer.provideMerge(SessionRuntime.layer),
				Layer.provideMerge(sandboxes),
				Layer.provideMerge(Context.layer),
				Layer.provideMerge(SessionLive.layer),
				Layer.provideMerge(Event.layer),
				Layer.provideMerge(EventRegistry.layer(definitions)),
				Layer.provideMerge(database),
				Layer.provideMerge(global),
			);
		}),
	);

export * as Harness from "./harness.ts";
