/**
 * Finds the CodeWork TUI binary. Running it is the CLI's job: the child must
 * share the CLI's lifetime and terminal, which the CLI's own runtime manages.
 */
export { LauncherError, platform, resolveBinary, type Platform } from "./binary.ts";

/** The environment variable the Rust TUI reads for the server endpoint. */
export const ENV_SERVER = "CODEWORK_RPC_SERVER";
