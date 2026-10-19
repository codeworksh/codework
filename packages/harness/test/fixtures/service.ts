import { Effect, Layer } from "effect";
import { SandboxFileSystem } from "../../src/sandbox/fs/filesystem.ts";
import { Local } from "../../src/sandbox/fs/vfs.ts";
import { HostExe } from "../../src/sandbox/shell/host.ts";
import { SandboxIO } from "../../src/sandbox/io.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";

export interface SandboxEnv<E = never> {
	/** The raw local primitives; `withService` builds the filesystem over them. */
	readonly sandbox: Sandbox.LocalBackend<E>;
	/** Where relative paths resolve. Supplied by the mount, never by the VFS. */
	readonly cwd?: string;
	readonly dispose?: () => Promise<void>;
}

export type MakeSandbox<E = never> = () => Promise<SandboxEnv<E>>;

/**
 * Promise view of the Effect service, so the behavioural spec below reads as
 * ordinary `async`/`await` and a typed failure surfaces as a rejection. That is
 * exactly the backend-facing `Provider` shape. Test ergonomics only — runtime
 * code consumes the Effect surface directly.
 */
export type PromiseFileSystem = SandboxFileSystem.Provider;

const toPromise = (fs: SandboxFileSystem.Interface): PromiseFileSystem => ({
	readFile: (path) => Effect.runPromise(fs.readFile(path)),
	readFileBuffer: (path) => Effect.runPromise(fs.readFileBuffer(path)),
	readBytes: (path, offset, length) => Effect.runPromise(fs.readBytes(path, offset, length)),
	writeFile: (path, content) => Effect.runPromise(fs.writeFile(path, content)),
	stat: (path) => Effect.runPromise(fs.stat(path)),
	...(fs.lstat === undefined ? {} : { lstat: (path: string) => Effect.runPromise(fs.lstat!(path)) }),
	readdir: (path) => Effect.runPromise(fs.readdir(path)),
	exists: (path) => Effect.runPromise(fs.exists(path)),
	mkdir: (path, options) => Effect.runPromise(fs.mkdir(path, options)),
	rm: (path, options) => Effect.runPromise(fs.rm(path, options)),
	realpath: (path) => Effect.runPromise(fs.realpath(path)),
	scanLines: (path, options) => Effect.runPromise(fs.scanLines(path, options)),
});

/**
 * Build the sandbox, hand a Promise view of the live `SandboxFileSystem.Service`
 * to a plain async body, and dispose afterwards.
 */
export const withService = async <A, E>(
	make: MakeSandbox<E>,
	body: (fs: PromiseFileSystem) => Promise<A>,
): Promise<A> => {
	const env = await make();
	try {
		return await Effect.runPromise(
			Effect.gen(function* () {
				const fs = yield* SandboxFileSystem.Service;
				return yield* Effect.promise(() => body(toPromise(fs)));
			}).pipe(
				Effect.scoped,
				Effect.provide(
					// The transport is cwd-neutral, so the working directory arrives
					// through a mount over it — the same path production takes.
					Layer.provideMerge(
						SandboxIO.mount(SandboxIO.host(env.cwd ?? "/")),
						Layer.provideMerge(Layer.merge(Local.layer, HostExe.layer()), env.sandbox),
					),
				),
			),
		);
	} finally {
		await env.dispose?.();
	}
};
