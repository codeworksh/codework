import { Context, Deferred, Duration, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, type HttpClientResponse } from "effect/http";
import type { SandboxFileSystem } from "../sandbox/fs/filesystem.ts";
import type { SandboxIO } from "../sandbox/io.ts";
import { type ISandboxExe, quote, quoteArgv } from "../sandbox/shell/shell.ts";
import { posix } from "../util/posix.ts";

/**
 * The search binaries a tool runs inside the mounted sandbox, found or installed
 * on first use. A sandbox is an environment we do not control: what it has, it
 * has. When a binary is missing and cannot be installed, the tool tells the model
 * so instead of falling back to another engine.
 *
 * - `virtual` mounts run just-bash, whose `rg` is built in and which has no `fd`.
 *   Nothing is probed there: just-bash's `which` answers for commands it lacks.
 * - `local` and `remote` mounts are probed once per sandbox. A missing binary is
 *   downloaded on the host from its GitHub release and installed where that kind
 *   keeps binaries: on the host (`local`) in {@link HostBin}, the harness home's
 *   `bin`; in a `remote` sandbox in its own `$HOME/.codework/bin`, which has nothing
 *   to do with the host's home. A remote needs no network of its own.
 *
 * Only an available binary is remembered, for the life of the process: the probe
 * is one command, and a remembered "missing" would go stale the moment it is
 * installed.
 */

export type Name = "rg" | "fd";

/** `<home>/bin` on the host, where binaries for `local` mounts are installed. */
export class HostBin extends Context.Service<HostBin, string>()("@codeworksh/harness/tool/binary/HostBin") {}

export type Resolved =
	| { readonly _tag: "Available"; readonly command: string }
	| { readonly _tag: "Unavailable"; readonly message: string };

interface Spec {
	readonly label: string;
	readonly repo: string;
	readonly tagPrefix: string;
	/** Names tried on `PATH`, after the installed copy. */
	readonly commands: ReadonlyArray<string>;
	readonly asset: (version: string, os: "darwin" | "linux", arch: "x86_64" | "aarch64") => string;
}

const specs: Record<Name, Spec> = {
	rg: {
		label: "ripgrep (rg)",
		repo: "BurntSushi/ripgrep",
		tagPrefix: "",
		commands: ["rg"],
		asset: (version, os, arch) =>
			`ripgrep-${version}-${arch}-${os === "darwin" ? "apple-darwin" : "unknown-linux-musl"}.tar.gz`,
	},
	fd: {
		label: "fd",
		repo: "sharkdp/fd",
		tagPrefix: "v",
		commands: ["fd", "fdfind"],
		asset: (version, os, arch) =>
			`fd-v${version}-${arch}-${os === "darwin" ? "apple-darwin" : "unknown-linux-musl"}.tar.gz`,
	},
};

const NETWORK_TIMEOUT = Duration.seconds(10);
const DOWNLOAD_TIMEOUT = Duration.seconds(120);

/** Why a missing binary could not be installed; the model reads the message. */
class InstallError extends Schema.TaggedError<InstallError>()("InstallError", { message: Schema.String }) {}

const installError = (message: string) => new InstallError({ message });

const available = new Map<string, Deferred.Deferred<Resolved>>();
const keyOf = (sandbox: SandboxIO.Identity, name: Name) => `${sandbox.id}\0${name}`;

const run = (shell: ISandboxExe, command: string) =>
	shell.exec(command).pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 127 })));

const works = (shell: ISandboxExe, command: string) =>
	Effect.map(run(shell, `${quote(command)} --version`), (result) => result.exitCode === 0);

/** A GET whose `read` of the response, body included, finishes within `timeout`. */
const get = <A>(
	url: string,
	timeout: Duration.Input,
	read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>,
	init: RequestInit = {},
) =>
	HttpClient.get(url).pipe(
		Effect.flatMap(read),
		Effect.timeout(timeout),
		Effect.mapError((cause) =>
			Schema.is(InstallError)(cause)
				? cause
				: installError(`${url}: ${cause instanceof Error ? cause.message : String(cause)}`),
		),
		Effect.provide(FetchHttpClient.layer),
		Effect.provideService(FetchHttpClient.RequestInit, init),
	);

/** The latest release, read from the redirect of the release page; the API endpoint is rate limited. */
const latestVersion = (repo: string) =>
	Effect.gen(function* () {
		const response = yield* get(`https://github.com/${repo}/releases/latest`, NETWORK_TIMEOUT, Effect.succeed, {
			redirect: "manual",
		});
		const location = response.headers["location"] ?? "";
		const tag = new URL(location, "https://github.com").pathname.split("/").pop();
		if (!location.includes("/releases/tag/") || !tag)
			return yield* installError(`Failed to resolve latest ${repo} release: HTTP ${response.status}`);
		return decodeURIComponent(tag).replace(/^v/, "");
	});

const platformOf = (shell: ISandboxExe) =>
	Effect.gen(function* () {
		const [os, arch] = (yield* run(shell, "uname -sm")).stdout.trim().toLowerCase().split(/\s+/);
		const mappedOs = os === "darwin" || os === "linux" ? os : undefined;
		const mappedArch =
			arch === "x86_64" || arch === "amd64"
				? "x86_64"
				: arch === "aarch64" || arch === "arm64"
					? "aarch64"
					: undefined;
		if (mappedOs === undefined || mappedArch === undefined)
			return yield* installError(`Unsupported platform: ${os ?? "unknown"}/${arch ?? "unknown"}`);
		return { os: mappedOs, arch: mappedArch } as const;
	});

/** Unpacks with the sandbox's own `tar`, as Pi does on its host; the archive layout varies by release. */
const unpack = [
	"set -e",
	'dir=$1; archive=$2; name=$3; tmp="$dir/.extract-$name-$$"',
	'trap \'rm -rf "$tmp" "$archive"\' EXIT',
	'mkdir -p "$tmp"',
	'tar -xzf "$archive" -C "$tmp"',
	'found=$(find "$tmp" -type f -name "$name" | head -n 1)',
	'[ -n "$found" ] || { echo "binary $name not found in archive" >&2; exit 1; }',
	'mv "$found" "$dir/$name"',
	'chmod 755 "$dir/$name"',
].join("\n");

const install = (name: Name, shell: ISandboxExe, fs: SandboxFileSystem.Interface, dir: string) =>
	Effect.gen(function* () {
		const spec = specs[name];
		const { os, arch } = yield* platformOf(shell);
		// Pi pins fd on Intel macs, where later releases ship no build.
		const version =
			name === "fd" && os === "darwin" && arch === "x86_64" ? "10.3.0" : yield* latestVersion(spec.repo);
		const asset = spec.asset(version, os, arch);
		const url = `https://github.com/${spec.repo}/releases/download/${spec.tagPrefix}${version}/${asset}`;
		const bytes = new Uint8Array(
			yield* get(url, DOWNLOAD_TIMEOUT, (response) =>
				response.status === 200
					? response.arrayBuffer
					: Effect.fail(installError(`Download failed with HTTP ${response.status}: ${url}`)),
			),
		);
		const archive = posix.join(dir, `.${asset}`);
		yield* fs
			.writeFile(archive, bytes)
			.pipe(
				Effect.mapError((error) =>
					installError(
						`Cannot write ${archive}: ${error.cause instanceof Error ? error.cause.message : error.message}`,
					),
				),
			);
		const result = yield* run(shell, `sh -c ${quote(unpack)} _ ${quoteArgv([dir, archive, name])}`);
		if (result.exitCode !== 0)
			return yield* installError(`Failed to unpack ${asset}: ${(result.stderr || result.stdout).trim()}`);
		return posix.join(dir, name);
	});

/** Where `kind` keeps installed binaries. */
const binDir = (sandbox: SandboxIO.Identity, shell: ISandboxExe) =>
	Effect.gen(function* () {
		if (sandbox.kind === "local") return yield* HostBin;
		const home = (yield* run(shell, 'printf %s "$HOME"')).stdout.trim();
		return posix.join(home || "/tmp", ".codework", "bin");
	});

const resolve = (name: Name, sandbox: SandboxIO.Identity, shell: ISandboxExe, fs: SandboxFileSystem.Interface) =>
	Effect.gen(function* () {
		const dir = yield* binDir(sandbox, shell);
		for (const command of [posix.join(dir, name), ...specs[name].commands]) {
			if (yield* works(shell, command)) return { _tag: "Available", command } as const;
		}
		const installed = yield* install(name, shell, fs, dir).pipe(Effect.result);
		if (installed._tag === "Success" && (yield* works(shell, installed.success)))
			return { _tag: "Available", command: installed.success } as const;
		const reason = installed._tag === "Failure" ? `: ${installed.failure.message}` : "";
		return {
			_tag: "Unavailable",
			message: `${specs[name].label} is not available in this sandbox and could not be installed${reason}`,
		} as const;
	});

const virtual = (name: Name): Resolved =>
	name === "rg"
		? { _tag: "Available", command: "rg" }
		: { _tag: "Unavailable", message: `${specs[name].label} is not available in this sandbox` };

/**
 * The shared probe for `name` in this sandbox, started when none is remembered.
 * It runs detached, so cancelling the call that started it cannot cancel it for
 * the others waiting on it; an unavailable result is not remembered, so the next
 * call tries again.
 */
const probe = (name: Name, sandbox: SandboxIO.Identity, shell: ISandboxExe, fs: SandboxFileSystem.Interface) =>
	Effect.gen(function* () {
		const key = keyOf(sandbox, name);
		const existing = available.get(key);
		if (existing !== undefined) return existing;
		const deferred = Deferred.makeUnsafe<Resolved>();
		available.set(key, deferred);
		yield* resolve(name, sandbox, shell, fs).pipe(
			Effect.onExit((exit) =>
				Effect.sync(() => {
					if ((exit._tag === "Failure" || exit.value._tag === "Unavailable") && available.get(key) === deferred)
						available.delete(key);
				}),
			),
			Effect.onExit((exit) => Deferred.done(deferred, exit)),
			Effect.forkDetach,
		);
		return deferred;
	});

/** The command to run `name` with in this sandbox. */
export const ensure = (
	name: Name,
	sandbox: SandboxIO.Identity,
	shell: ISandboxExe,
	fs: SandboxFileSystem.Interface,
): Effect.Effect<Resolved, never, HostBin> =>
	sandbox.kind === "virtual"
		? Effect.succeed(virtual(name))
		: Effect.flatMap(probe(name, sandbox, shell, fs), Deferred.await);

export interface Unavailable {
	readonly _tag: "Unavailable";
	readonly message: string;
}

/**
 * Run `use` with the command for `name`. When the run reports the binary gone
 * (`exitCode` 127, e.g. a sandbox reset to a fresh image), the remembered probe is
 * dropped and the run is tried once more with a fresh one. Only the probe that
 * gave the stale command is dropped, so concurrent retries share one new probe.
 */
export const withCommand = <A extends { readonly exitCode: number }, E, R>(
	name: Name,
	sandbox: SandboxIO.Identity,
	shell: ISandboxExe,
	fs: SandboxFileSystem.Interface,
	use: (command: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A | Unavailable, E, R | HostBin> =>
	Effect.gen(function* () {
		if (sandbox.kind === "virtual") {
			const resolved = virtual(name);
			return resolved._tag === "Unavailable" ? resolved : yield* use(resolved.command);
		}
		for (let attempt = 0; ; attempt++) {
			const deferred = yield* probe(name, sandbox, shell, fs);
			const resolved = yield* Deferred.await(deferred);
			if (resolved._tag === "Unavailable") return resolved;
			const result = yield* use(resolved.command);
			if (result.exitCode !== 127 || attempt > 0) return result;
			const key = keyOf(sandbox, name);
			if (available.get(key) === deferred) available.delete(key);
		}
	});

export * as Binary from "./binary.ts";
