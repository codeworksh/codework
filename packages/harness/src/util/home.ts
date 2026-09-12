import { homedir } from "node:os";

/**
 * Expand a leading `~`, leaving every other value untouched for the caller to resolve.
 *
 * The path module is the caller's, because the home directory is host-native while some
 * callers spell their paths POSIX-only. Anything beyond the tilde is not this function's
 * business: it never resolves, normalizes, or validates.
 */
export const expandTilde = (value: string, path: { readonly join: (...parts: ReadonlyArray<string>) => string }) =>
	value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
