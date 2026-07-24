import { Context, Layer } from "effect";
import { posix as path } from "node:path";
import { uuidv7 } from "uuidv7";

/**
 * Identity of the sandbox environment a service is running against.
 *
 * An environment is a **filesystem namespace**, not a machine: `/workspace`
 * resolves to different content in each one, so anything persisted about a path
 * has to say which namespace it belongs to. Two local sandboxes rooted at
 * different directories share `local` — absolute paths agree between them — but
 * an in-memory VFS on the same machine is a different namespace entirely.
 *
 * The id is an **address**: `kind` names the backend, and every kind except
 * `local` carries the instance that names which one. It is written to
 * `sandbox_env_id` and must therefore hold only identity — never credentials,
 * which come from configuration instead.
 *
 * ```
 * local                   the developer's machine
 * memory:<minted>         an in-process VFS, gone when the process exits
 * sqldb:/var/fs.db        a file-backed VFS; the file is the state
 * sqldb:<minted>          an in-memory sqlite VFS, likewise ephemeral
 * vercel:my-box           one specific Vercel sandbox
 * daytona:abc123          one specific Daytona sandbox
 * ```
 */

export const kinds = ["local", "memory", "sqldb", "vercel", "daytona"] as const;
export type Kind = (typeof kinds)[number];
export type EphemeralKind = "memory" | "sqldb";

const isKind = (value: string): value is Kind => (kinds as ReadonlyArray<string>).includes(value);

export type Address =
	| { readonly kind: "local" }
	| {
			readonly kind: Exclude<Kind, "local">;
			/** Which instance of that backend. */
			readonly instance: string;
	  };

export class EnvId extends Context.Service<EnvId, string>()("@codework/sandbox/env-id") {}

/** The implicit environment: the developer's own machine. */
export const DEFAULT = "local";

export const format = (address: Address): string =>
	address.kind === "local" ? address.kind : `${address.kind}:${address.instance}`;

/**
 * Parse a canonical address. Split on the first `:` so an instance may itself
 * contain colons; reject unknown kinds, missing instances, and aliases such as
 * `local:anything` whose requested id would differ from the provided service id.
 */
export const parse = (envId: string): Address | undefined => {
	const separator = envId.indexOf(":");
	const kind = separator === -1 ? envId : envId.slice(0, separator);
	if (!isKind(kind)) return undefined;

	if (kind === "local") return separator === -1 ? { kind } : undefined;
	if (separator === -1) return undefined;

	const instance = envId.slice(separator + 1);
	return instance.length === 0 ? undefined : { kind, instance };
};

/**
 * A fresh identity for a namespace that has none of its own. Ephemeral
 * backends need this for distinctness — so their rows never collide with
 * another namespace's — even though the address cannot outlive the process.
 */
export const mint = (kind: EphemeralKind): string => format({ kind, instance: uuidv7() });

/**
 * Whether an address can be resolved back to the *same* namespace later.
 *
 * `sqldb` straddles the line: an absolute path is the state and reattaches, but
 * a minted instance is an in-memory database that dies with the process. The
 * distinction matters because resolving a non-reattachable address would build
 * an empty namespace wearing the right name — data loss that looks like
 * success.
 */
export const isReattachable = (address: Address): boolean => {
	switch (address.kind) {
		case "local":
			return true;
		case "sqldb":
			return path.isAbsolute(address.instance);
		case "memory":
			return false;
		case "vercel":
		case "daytona":
			// Addressable while the remote sandbox lives; a terminated box fails
			// to attach rather than being silently recreated.
			return true;
	}
};

export const layer = (id: string) => Layer.succeed(EnvId, id);

export const defaultLayer = layer(DEFAULT);

export * as SandboxEnv from "./env";
