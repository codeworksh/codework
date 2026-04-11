import type { TSchema } from "@sinclair/typebox";

export interface NormalizedError {
	message: string;
	name?: string;
	stack?: string;
	line?: number;
}

export interface ExecutionResult<T = unknown> {
	success: boolean;
	value?: T;
	logs?: string[];
	error?: NormalizedError;
}

export interface ToolBinding {
	name: string;
	description: string;
	inputSchema: TSchema;
	outputSchema?: TSchema;
	errorSchema?: TSchema;
	execute: (callID: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
}

export interface Context {
	execute: <T = unknown>(code: string) => Promise<ExecutionResult<T>>;
	dispose: () => Promise<void>;
}

export interface DriverContextConfig {
	bindings: Record<string, ToolBinding>;
	timeout?: number;
	memoryLimit?: number;
	signal?: AbortSignal;
}

export interface Driver {
	createContext: (config: DriverContextConfig) => Promise<Context>;
}
