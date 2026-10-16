/* @effect-diagnostics nodeBuiltinImport:off -- the launcher resolves a file on the host. */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** The Rust binary, by the package that publishes a prebuilt for this platform. */
export interface Platform {
	readonly os: "darwin" | "linux";
	readonly arch: "arm64" | "x64";
}

/** Resolve the current platform, or `undefined` where no prebuilt is published. */
export function platform(): Platform | undefined {
	const os = process.platform;
	const arch = process.arch;
	if (os !== "darwin" && os !== "linux") return undefined;
	if (arch !== "arm64" && arch !== "x64") return undefined;
	// Intel Macs are no longer supported; `@codeworksh/tui-darwin-x64` is deprecated.
	if (os === "darwin" && arch === "x64") return undefined;
	return { os, arch };
}

const packageFor = (value: Platform) => `@codeworksh/tui-${value.os}-${value.arch}`;
const binaryName = "codework-tui";

/** A source-tree build, used when neither an override nor a platform package is present. */
function devBuild(): string | undefined {
	for (const profile of ["release", "debug"]) {
		const candidate = fileURLToPath(new URL(`../target/${profile}/${binaryName}`, import.meta.url));
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export class LauncherError extends Error {}

/**
 * The `codework-tui` executable to run.
 *
 * Resolution order, most specific first:
 * 1. `CODEWORK_TUI_BIN` — an explicit path, for a local build or a test.
 * 2. The platform package's `bin/` — what a normal install ships.
 * 3. A `target/{release,debug}` build in the source tree, so `codework tui`
 *    works from a checkout without publishing anything.
 *
 * Nothing is ever downloaded: a missing binary is an error that names the
 * package to install, because a silent runtime fetch is both surprising and a
 * supply-chain surface.
 */
export function resolveBinary(env: NodeJS.ProcessEnv = process.env): string {
	const override = env["CODEWORK_TUI_BIN"];
	if (override !== undefined && override.length > 0) {
		if (!existsSync(override)) throw new LauncherError(`CODEWORK_TUI_BIN points at a missing file: ${override}`);
		return override;
	}

	const current = platform();
	if (current !== undefined) {
		try {
			// Resolve through the package's own manifest so the binary path is not part of
			// the platform package's public `exports` surface.
			const manifest = require.resolve(`${packageFor(current)}/package.json`);
			// In a checkout the platform package is a workspace link with no binary staged.
			const binary = join(dirname(manifest), "bin", binaryName);
			if (existsSync(binary)) return binary;
		} catch {
			// Fall through to the source-tree build below.
		}
	}

	const dev = devBuild();
	if (dev !== undefined) return dev;

	throw new LauncherError(
		current === undefined
			? `no prebuilt CodeWork TUI is published for ${process.platform}-${process.arch}`
			: `the CodeWork TUI binary is missing. Install ${packageFor(current)}, or build it with \`cargo build --release\` in packages/tui`,
	);
}
