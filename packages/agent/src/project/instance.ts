import { iife } from "@codeworksh/utils";
import { Context } from "../util/context.ts";
import { Filesystem } from "@codeworksh/utils";
import { Log } from "../util/log.ts";
import { Project } from "./project.ts";
import { State } from "./state.ts";

interface IContext {
	directory: string;
	worktree: string;
	project: Project.Info;
}
const context = Context.create<IContext>("instance");
const cache = new Map<string, Promise<IContext>>();

const disposal = {
	all: undefined as Promise<void> | undefined,
};

function boot(input: { directory: string; init?: () => Promise<any>; project?: Project.Info; worktree?: string }) {
	return iife(async () => {
		const ctx =
			input.project && input.worktree
				? {
						directory: input.directory,
						worktree: input.worktree,
						project: input.project,
					}
				: await Project.fromDirectory(input.directory).then(({ project, worktree }) => ({
						directory: input.directory,
						worktree: worktree,
						project,
					}));
		await context.provide(ctx, async () => {
			await input.init?.();
		});
		return ctx;
	});
}

function track(directory: string, next: Promise<IContext>) {
	const task = next.catch((error) => {
		if (cache.get(directory) === task) cache.delete(directory);
		throw error;
	});
	cache.set(directory, task);
	return task;
}

export const Instance = {
	async provide<R>(input: { directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R> {
		let existing = cache.get(input.directory);
		if (!existing) {
			Log.Default.info("creating instance", { directory: input.directory });
			existing = iife(async () => {
				const { project, worktree } = await Project.fromDirectory(input.directory);
				const ctx = {
					directory: input.directory,
					worktree,
					project,
				};
				await context.provide(ctx, async () => {
					await input.init?.();
				});
				return ctx;
			});
			cache.set(input.directory, existing);
		}
		const ctx = await existing;
		return context.provide(ctx, async () => {
			return input.fn();
		});
	},
	get directory() {
		return context.use().directory;
	},
	get worktree() {
		return context.use().worktree;
	},
	get project() {
		return context.use().project;
	},
	/**
	 * Check if a path is within the project boundary.
	 * Returns true if path is inside Instance.directory OR Instance.worktree.
	 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
	 */
	containsPath(filepath: string) {
		if (Filesystem.contains(Instance.directory, filepath)) return true;
		// Non-git projects set worktree to "/" which would match ANY absolute path.
		if (Instance.worktree === "/") return false;
		return Filesystem.contains(Instance.worktree, filepath);
	},
	state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
		return State.create(() => Instance.directory, init, dispose);
	},
	async reload(input: { directory: string; init?: () => Promise<any>; project?: Project.Info; worktree?: string }) {
		const directory = Filesystem.resolve(input.directory);
		Log.Default.info("reloading instance", { directory });
		await State.dispose(directory);
		cache.delete(directory);
		const next = track(directory, boot({ ...input, directory }));
		// @sanchitrk: send durable stream event?
		// emit(directory);
		return await next;
	},
	async dispose() {
		Log.Default.info("disposing instance", { directory: Instance.directory });
		await State.dispose(Instance.directory);
		cache.delete(Instance.directory);
		// @sanchitrk: send durable stream event?
		// GlobalBus.emit("event", {
		//   directory: Instance.directory,
		//   payload: {
		//     type: "server.instance.disposed",
		//     properties: {
		//       directory: Instance.directory,
		//     },
		//   },
		// });
	},
	async disposeAll() {
		if (disposal.all) return disposal.all;

		disposal.all = iife(async () => {
			Log.Default.info("disposing all instances");
			const entries = [...cache.entries()];
			for (const [key, value] of entries) {
				if (cache.get(key) !== value) continue;

				const ctx = await value.catch((error) => {
					Log.Default.warn("instance dispose failed", { key, error });
					return undefined;
				});

				// before deleting the failed instance (catch-ed) undefined
				// do safety check before deleting the failed instance, for this directory in cache
				// for the directory(key) a value must be the same when iterated.
				// 'cause of async operation, value might have been changed, for the key
				if (!ctx) {
					if (cache.get(key) === value) cache.delete(key);
					continue;
				}

				// cache key and value are different, move on.
				if (cache.get(key) !== value) continue;

				// dispose of resources for the same context (IContext)
				// the only way for `dispose` to know which IContext, is via within the context.
				await context.provide(ctx, async () => {
					await Instance.dispose();
				});
			}
		}).finally(() => {
			disposal.all = undefined;
		});

		return disposal.all;
	},
};
