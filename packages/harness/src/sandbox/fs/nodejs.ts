import { create, RealFSProvider } from "@platformatic/vfs";
import { Layer } from "effect";
import { Process } from "../utils/process";
import { Local } from "./vfs";

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
	const vfs = create(new RealFSProvider("/"), {
		moduleHooks: false,
		virtualCwd: true,
	});

	return Layer.merge(Layer.succeed(Local.Vfs, vfs), Process.host);
};

export * as EnvNodeJSDefault from "./nodejs";
