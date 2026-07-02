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

export * as Executor from "./executor";
export * as Registry from "./registry";
export * as Tool from "./tool";
export * as Truncate from "./truncate";

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
} from "./shell";

export {
	make as makeToolProgress,
	ToolProgress,
	noop as toolProgressNoop,
	type IToolProgress,
	type ToolProgressPartial,
} from "./progress";

export { bashDef, bashTool } from "./bash";
