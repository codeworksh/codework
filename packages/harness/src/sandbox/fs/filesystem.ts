import { Context, Effect, Schema } from "effect";
import { posix } from "../../util/posix.ts";

/**
 * The runtime filesystem contract, independent of any backend.
 *
 * Two surfaces, deliberately:
 * - {@link Provider} is what a backend implements — plain promises that reject,
 *   matching every SDK we wrap.
 * - {@link Interface} is what the harness consumes — Effect with a typed error
 *   channel and tracing spans. {@link fromProvider} bridges the two exactly
 *   once, so no consumer ever writes `Effect.tryPromise` against a filesystem.
 *
 * Implementations:
 * - Local:
 * implement it over a VFS (`./local`);
 * local filesystem use OS primitives; hence have broader filesytem capabilities.
 *
 * - Remote:
 * implement it over a provider (`./remote`).
 * remote filesytems depends on the interface provided by the remote provider; hence can have limited filesytem capabilities.
 *
 * `isFile`/`isDirectory` are required booleans; size, mtime, and isSymbolicLink are omitted when the
 * backend cannot report them — never fabricated.
 *
 * **Paths are POSIX, and the harness is Unix-only (for now!).** Every path uses `/`
 * separators on both the host and inside a sandbox — Windows is not supported,
 * so no translation layer exists. Consumers must use the shared Effect POSIX
 * path implementation, never the platform default, or a host running the harness would
 * impose its own flavour on a remote sandbox's paths. Relative paths resolve
 * against the backend's configured `cwd`.
 */

export class OperationUnsupportedError extends Schema.TaggedError<OperationUnsupportedError>()(
	"OperationUnsupportedError",
	{
		operation: Schema.String,
		message: Schema.String,
	},
) {}

/** A backend operation failed. `cause` carries the provider's own rejection. */
export class FileSystemError extends Schema.TaggedError<FileSystemError>()("SandboxFileSystemError", {
	method: Schema.String,
	path: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export interface FileStat {
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly isSymbolicLink?: boolean;
	readonly size?: number;
	readonly mtime?: Date;
}

export interface RmOptions {
	readonly recursive?: boolean;
	readonly force?: boolean;
}

/** Whether a provider failure means the path itself is definitively absent. */
export const isNotFoundError = (cause: unknown) => {
	const code = (cause as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * The backend-facing contract. Backends author plain promises and let them
 * reject; {@link fromProvider} turns rejections into typed failures.
 */
export interface Provider {
	readonly readFile: (path: string) => Promise<string>;
	readonly readFileBuffer: (path: string) => Promise<Uint8Array>;
	/**
	 * Write the file. Parents may be missing — do not create them here;
	 * {@link fromProvider} owns that guarantee for every backend.
	 */
	readonly writeFile: (path: string, content: string | Uint8Array) => Promise<void>;
	readonly stat: (path: string) => Promise<FileStat>;
	readonly readdir: (path: string) => Promise<string[]>;
	readonly exists: (path: string) => Promise<boolean>;
	readonly mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
	readonly rm: (path: string, options?: RmOptions) => Promise<void>;
	/**
	 * Metadata for the directory entry itself rather than a symlink's target.
	 * Optional: a backend whose `stat` has mixed symlink semantics implements it
	 * so symlink identity is asked for explicitly, never inferred.
	 */
	readonly lstat?: (path: string) => Promise<FileStat>;
}

/**
 * The consumer-facing contract. `exists` distinguishes "absent" from "could not
 * tell": a backend failure is a typed failure, not `false`, so a caller acting
 * on absence never acts on a network blip. Use `SandboxFs.existsOrFalse` where
 * a best-effort answer really is wanted.
 */
export interface Interface {
	readonly readFile: (path: string) => Effect.Effect<string, FileSystemError>;
	readonly readFileBuffer: (path: string) => Effect.Effect<Uint8Array, FileSystemError>;
	/** Creates missing parent directories, on every backend. */
	readonly writeFile: (path: string, content: string | Uint8Array) => Effect.Effect<void, FileSystemError>;
	readonly stat: (path: string) => Effect.Effect<FileStat, FileSystemError>;
	readonly readdir: (path: string) => Effect.Effect<string[], FileSystemError>;
	readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>;
	readonly mkdir: (path: string, options?: { recursive?: boolean }) => Effect.Effect<void, FileSystemError>;
	readonly rm: (path: string, options?: RmOptions) => Effect.Effect<void, FileSystemError | OperationUnsupportedError>;
	// `lstat` is present only when the backend supports it; check before calling.
	readonly lstat?: (path: string) => Effect.Effect<FileStat, FileSystemError>;
}

/** The runtime filesystem service — the live {@link Interface} for the active sandbox. */
export class Service extends Context.Service<Service, Interface>()(
	"@codeworksh/harness/sandbox/fs/filesystem/Service",
) {}

/**
 * Reject `rm` options a provider does not implement, before any mutation. Only
 * `recursive` and `force` are part of the contract; anything else is refused
 * loudly rather than silently ignored.
 */
export const validateRmOptions = (
	options: RmOptions | undefined,
	operation = "rm",
): Effect.Effect<void, OperationUnsupportedError> =>
	Effect.suspend(() => {
		for (const option of Object.keys((options ?? {}) as Record<string, unknown>)) {
			if (option === "recursive" || option === "force") continue;
			return Effect.fail(new OperationUnsupportedError({ operation, message: `Unsupported rm option: ${option}` }));
		}
		return Effect.void;
	});

/**
 * Lift a {@link Provider} into the runtime {@link Interface}: one place that
 * converts rejections into {@link FileSystemError}, validates `rm` options,
 * creates missing parents on write, and names a tracing span per operation.
 */
export const fromProvider = (provider: Provider): Interface => {
	const attempt = <A>(method: string, path: string, run: () => Promise<A>) =>
		Effect.tryPromise({ try: run, catch: (cause) => new FileSystemError({ method, path, cause }) });

	// The parent-creation guarantee, installed once for every backend instead of
	// re-implemented per provider: anything that reaches `Interface` reaches it
	// through here, so a backend cannot forget it.
	//
	// Lazy by design — try the write first, so the happy path stays a single call
	// and no remote backend pays a round-trip per write. A failure is usually a
	// missing parent, so create it and retry once. The mkdir's own error is
	// dropped on purpose: when the write failed for some other reason (EACCES,
	// EROFS, a dropped connection), the retry reproduces it, and *that* is the
	// failure the caller must see rather than a misleading mkdir error standing
	// in for it.
	const writeCreatingParents = (path: string, content: string | Uint8Array) => {
		const write = attempt("writeFile", path, () => provider.writeFile(path, content));
		const parent = posix.dirname(path);
		return write.pipe(
			Effect.catch(() =>
				attempt("mkdir", parent, () => provider.mkdir(parent, { recursive: true })).pipe(
					Effect.ignore,
					Effect.andThen(write),
				),
			),
		);
	};

	return {
		readFile: Effect.fn("SandboxFileSystem.readFile")((path: string) =>
			attempt("readFile", path, () => provider.readFile(path)),
		),
		readFileBuffer: Effect.fn("SandboxFileSystem.readFileBuffer")((path: string) =>
			attempt("readFileBuffer", path, () => provider.readFileBuffer(path)),
		),
		writeFile: Effect.fn("SandboxFileSystem.writeFile")(writeCreatingParents),
		stat: Effect.fn("SandboxFileSystem.stat")((path: string) => attempt("stat", path, () => provider.stat(path))),
		// carried through only when the backend actually implements it
		...(provider.lstat === undefined
			? {}
			: {
					lstat: Effect.fn("SandboxFileSystem.lstat")((path: string) =>
						attempt("lstat", path, () => provider.lstat!(path)),
					),
				}),
		readdir: Effect.fn("SandboxFileSystem.readdir")((path: string) =>
			attempt("readdir", path, () => provider.readdir(path)),
		),
		// A backend that cannot answer fails; it does not report "absent". A
		// caller acting on absence — deleting a record, say — must not be told
		// the path is gone because a token expired or a request timed out.
		exists: Effect.fn("SandboxFileSystem.exists")((path: string) =>
			attempt("exists", path, () => provider.exists(path)),
		),
		mkdir: Effect.fn("SandboxFileSystem.mkdir")((path: string, options?: { recursive?: boolean }) =>
			attempt("mkdir", path, () => provider.mkdir(path, options)),
		),
		rm: Effect.fn("SandboxFileSystem.rm")((path: string, options?: RmOptions) =>
			validateRmOptions(options).pipe(Effect.andThen(attempt("rm", path, () => provider.rm(path, options)))),
		),
	};
};

/**
 * Bind a cwd-neutral filesystem to one mount's working directory.
 *
 * The counterpart of `Shell.withCwd`, and the reason relative paths mean the
 * same thing to both: a shared transport stays rooted at the namespace root, so
 * resolution happens here, per mount, rather than inside a VFS whose `chdir` is
 * global state two mounts would fight over.
 */
export const withCwd = (fs: Interface, cwd: string): Interface => {
	const at = (path: string) => posix.resolve(cwd, path);
	return {
		readFile: (path) => fs.readFile(at(path)),
		readFileBuffer: (path) => fs.readFileBuffer(at(path)),
		writeFile: (path, content) => fs.writeFile(at(path), content),
		stat: (path) => fs.stat(at(path)),
		readdir: (path) => fs.readdir(at(path)),
		exists: (path) => fs.exists(at(path)),
		mkdir: (path, options) => fs.mkdir(at(path), options),
		rm: (path, options) => fs.rm(at(path), options),
		// carried through only when the backend implements it, so a caller can
		// still detect absence by checking the property
		...(fs.lstat === undefined ? {} : { lstat: (path: string) => fs.lstat!(at(path)) }),
	};
};

export * as SandboxFileSystem from "./filesystem.ts";
