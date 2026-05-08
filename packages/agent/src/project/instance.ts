import { iife } from "@codeworksh/utils";
import { Context } from "../util/context";
import { Filesystem } from "@codeworksh/utils";
import { Log } from "../util/log";
import { Project } from "./project";
import { State } from "./state";
import { Bus } from "../streaming/bus";
import { BusEvent } from "../streaming/event";
import Type from "typebox";

interface IContext {
	id: string;
	directory: string;
	worktree: string;
	project: Project.Info;
}
const context = Context.create<IContext>("instance");
const cache = new Map<string, Promise<IContext>>();

const disposal = {
	all: undefined as Promise<void> | undefined,
};

async function emit({ id, directory }: { id: string; directory: string }) {
	const bus = await Bus.create({
		stream: true,
		producerId: "global",
		topic: "events",
	});
	const event = BusEvent.define(
		"server.instance.disposed",
		Type.Object({
			id: Type.String(),
			directory: Type.String(),
		}),
	);
	await bus.publish(event, { id, directory });
}

function boot(input: {
	id: string;
	directory: string;
	init?: () => Promise<any>;
	project?: Project.Info;
	worktree?: string;
}) {
	return iife(async () => {
		const ctx =
			input.project && input.worktree
				? {
						id: input.id,
						directory: input.directory,
						worktree: input.worktree,
						project: input.project,
					}
				: await Project.fromDirectory(input.directory).then(({ project, worktree }) => ({
						id: input.id,
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

function track(key: string, next: Promise<IContext>) {
	const task = next.catch((error) => {
		if (cache.get(key) === task) cache.delete(key);
		throw error;
	});
	cache.set(key, task);
	return task;
}

export const Instance = {
	async provide<R>(input: { id: string; directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R> {
		let existing = cache.get(input.id);
		if (!existing) {
			Log.Default.info("creating instance", { key: input.id, directory: input.directory });
			existing = track(input.id, boot(input));
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
	get id() {
		return context.use().id;
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
		return State.create(() => Instance.id, init, dispose);
	},
	async reload(input: {
		key: string;
		directory: string;
		init?: () => Promise<any>;
		project?: Project.Info;
		worktree?: string;
	}) {
		const key = input.key;
		const directory = Filesystem.resolve(input.directory);
		Log.Default.info("reloading instance", { key, directory });
		await State.dispose(key);
		cache.delete(key);
		const next = track(key, boot({ ...input, id: key, directory }));
		await emit({ id: key, directory });
		return await next;
	},
	async dispose() {
		Log.Default.info("disposing instance", { key: Instance.id, directory: Instance.directory });
		await State.dispose(Instance.id);
		cache.delete(Instance.id);
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

				// Before deleting a failed instance, make sure this cache key still points
				// at the same promise; async work may have replaced it while disposal ran.
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
