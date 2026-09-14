import { create, RealFSProvider } from "@platformatic/vfs";
import { Layer } from "effect";
// The VFS provider contract is Promise/sync-based, so Effect's FileSystem cannot back it.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import fs from "node:fs";
import { Process } from "../utils/process.ts";
import { Local } from "./vfs.ts";

// `RealFSProvider.realpath` mis-maps results for a `/` root (it looks for a
// `//` prefix and falls back to echoing the input), so with provider paths
// equal to OS paths, defer straight to the OS.
class HostProvider extends RealFSProvider {
	override realpath(path: string) {
		return fs.promises.realpath(path);
	}
	override realpathSync(path: string) {
		return fs.realpathSync(path);
	}
}

/**
 * The host VFS: provider-rooted at `/`, and never `chdir`ed.
 *
 * `chdir` is process-global state on a shared VFS, so baking a working directory
 * in here means two mounts at different directories cannot coexist — the second
 * would either see the first's or move it. The directory belongs to the mount
 * (`SandboxIO.mount`), which resolves relative paths per mount over this
 * transport.
 *
 * Having no virtual cwd is not the same as having `/` as one: a relative path
 * handed straight to this VFS still falls back to `process.cwd()`. That is a
 * reason to keep relative paths above the mount, not below it — nothing here
 * resolves them, and nothing here should.
 */
export const layer = () => {
	const vfs = create(new HostProvider("/"), {
		moduleHooks: false,
		virtualCwd: true,
	});

	return Layer.merge(Layer.succeed(Local.Vfs, vfs), Process.host);
};

export * as EnvNodeJSDefault from "./nodejs.ts";
