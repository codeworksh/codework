/**
 * The sandbox mount and driver contract, re-exported from `@codeworksh/plugin`.
 *
 * It lives there so a plugin's tools, and a third-party sandbox driver package, compile against
 * the same tags and codecs the harness mounts — not a structurally identical copy.
 *
 * The names are listed rather than star-exported. This module is a pack entry *and* the barrel
 * the bundled drivers import from, and a bundler cannot know what an external `export *` provides:
 * it emits an empty namespace object, and `SandboxDriver.AbsolutePath` reads `undefined` at
 * runtime in the built package while the source tests keep passing.
 */
export {
	SandboxDriver,
	SandboxFileSystem,
	SandboxInstance,
	SandboxIO,
	SandboxProvider,
	SandboxResource,
	SandboxShell,
} from "@codeworksh/plugin/sandbox";
