/**
 * Public surface of the tool layer
 *
 * Framework: `Tool` (define / make / implement / wire view),
 * `Executor` (decode → run → encode pipeline),
 * `Truncate` (output truncation utilities).
 * Capabilities:
 * `ToolShell` (cancellable exec),
 * `ToolProgress` (progress side-channel).
 */

export * as Executor from "./executor.ts";
export * as Registry from "./registry.ts";
export * as Tool from "./tool.ts";
export * as Truncate from "./truncate.ts";

export { ToolExecutionError } from "./error.ts";

export {
	fromSandboxShell,
	local as localToolShell,
	ToolShell,
	ToolShellError,
	ToolShellTimeout,
	type IToolShell,
	type LocalConfig,
	type ToolShellExecOptions,
	type ToolShellResult,
} from "./shell.ts";

export {
	make as makeToolProgress,
	ToolProgress,
	noop as toolProgressNoop,
	type IToolProgress,
	type ToolProgressPartial,
} from "./progress.ts";

export { bashDef, bashTool } from "./bash.ts";
