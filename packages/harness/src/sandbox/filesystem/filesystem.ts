import { Context, Schema } from "effect";

/**
 * The runtime filesystem contract, independent of any backend. Local sandboxes
 * implement it over a VFS (`./virtual`); remote sandboxes implement it over a
 * provider (`./remote`). VFS is a local-only concern, so it lives in `virtual.ts`
 * and never leaks here — remote providers depend only on this module.
 *
 * Inspired by flueframework's sandbox fs surface: isFile/isDirectory are
 * required booleans; size, mtime, and isSymbolicLink are omitted when the
 * backend cannot report them — never fabricated.
 */

export class OperationUnsupportedError extends Schema.TaggedErrorClass<OperationUnsupportedError>()(
	"OperationUnsupportedError",
	{
		operation: Schema.String,
		message: Schema.String,
	},
) {}

export interface FileStat {
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly isSymbolicLink?: boolean;
	readonly size?: number;
	readonly mtime?: Date;
}

export interface Interface {
	readonly readFile: (path: string) => Promise<string>;
	readonly readFileBuffer: (path: string) => Promise<Uint8Array>;
	readonly writeFile: (path: string, content: string | Uint8Array) => Promise<void>;
	readonly stat: (path: string) => Promise<FileStat>;
	readonly readdir: (path: string) => Promise<string[]>;
	readonly exists: (path: string) => Promise<boolean>;
	readonly mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
	readonly rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
}

/** The runtime filesystem service — the live {@link Interface} for the active sandbox. */
export class Service extends Context.Service<Service, Interface>()("@codework/sandbox/filesystem") {}

/**
 * Reject `rm` options a provider does not implement, before any mutation. Only
 * `recursive` and `force` are part of the contract; anything else is refused
 * loudly rather than silently ignored.
 */
export const assertRmOptions = (options: { recursive?: boolean; force?: boolean } | undefined, operation = "rm") => {
	for (const option of Object.keys((options ?? {}) as Record<string, unknown>)) {
		if (option === "recursive" || option === "force") continue;
		throw new OperationUnsupportedError({ operation, message: `Unsupported rm option: ${option}` });
	}
};

export * as SandboxFileSystem from "./filesystem";
