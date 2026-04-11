import { NamedError } from "@codeworksh/utils";
import { type Static, type TSchema, Type, TypeGuard } from "@sinclair/typebox";
import { transform } from "esbuild";
import { QuickJS } from "quickjs-wasi";
import { capitalize } from "remeda";
import { validateSchema } from "../utils/validation";
import { Agent } from "./agent";

export namespace CodeMode {
	const DEFAULT_TIMEOUT_MS = 30_000;
	const DEFAULT_MEMORY_LIMIT_MB = 128;

	export const ToolDefinitionErr = NamedError.create(
		"ToolDefinitionErr",
		Type.Object({
			message: Type.String(),
		}),
	);

	export const SandboxExecutionInputSchema = Type.Object({
		typescriptCode: Type.String({
			description:
				"TypeScript code to execute in the sandbox. Use external_* functions for host tools and return a value.",
		}),
	});
	export type SandboxExecutionInput = Static<typeof SandboxExecutionInputSchema>;

	export const SandboxExecutionOutputSchema = Type.Object({
		result: Type.Optional(Type.Unknown()),
		logs: Type.Optional(Type.Array(Type.String())),
	});
	export type SandboxExecutionOutput = Static<typeof SandboxExecutionOutputSchema>;

	export const SandboxExecutionErrorSchema = Type.Object({
		message: Type.String(),
		name: Type.Optional(Type.String()),
		stack: Type.Optional(Type.String()),
		line: Type.Optional(Type.Number()),
		logs: Type.Optional(Type.Array(Type.String())),
	});
	export type SandboxExecutionError = Static<typeof SandboxExecutionErrorSchema>;

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

	export interface ToolConfig {
		/**
		 * Driver for sandbox code execution
		 */
		driver: Driver;
		/**
		 * Tools to expose for functions in sandbox
		 */
		tools: Agent.AnyAgentTool[];
		/**
		 * Execution timeout in milliseconds (default: 30000)
		 */
		timeout?: number;
		/**
		 * Memory limit in MB for sandbox (default: 128)
		 */
		memoryLimit?: number;
	}

	export interface ToolBinding {
		name: string;
		description: string;
		inputSchema: TSchema;
		outputSchema?: TSchema;
		errorSchema?: TSchema;
		execute: (callID: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
	}

	/**
	 * Options for type stub generation
	 */
	export interface TypeGeneratorOptions {
		/**
		 * Include JSDoc comments with descriptions
		 * @default true
		 */
		includeDescriptions?: boolean;
	}

	function normalizeExecutionError(error: unknown): NormalizedError {
		if (error instanceof Error) {
			return {
				name: error.name,
				message: error.message,
				stack: error.stack,
				line: parseErrorLine(error.stack),
			};
		}

		if (typeof error === "object" && error !== null) {
			const candidate = error as Record<string, unknown>;
			return {
				name: typeof candidate.name === "string" ? candidate.name : undefined,
				message:
					typeof candidate.message === "string"
						? candidate.message
						: JSON.stringify(candidate) || "Unknown execution error",
				stack: typeof candidate.stack === "string" ? candidate.stack : undefined,
				line: typeof candidate.line === "number" ? candidate.line : parseErrorLine(candidate.stack),
			};
		}

		return {
			name: "Error",
			message: String(error),
		};
	}

	function parseErrorLine(stack: unknown): number | undefined {
		if (typeof stack !== "string") return undefined;
		const lineMatch = stack.match(/:(\d+)(?::\d+)?\)?$/m);
		return lineMatch ? Number(lineMatch[1]) : undefined;
	}

	function serializeForContent(value: unknown): string {
		return JSON.stringify(
			value,
			(_key, currentValue) => (typeof currentValue === "bigint" ? currentValue.toString() : currentValue),
			2,
		);
	}

	function toolContentToText(result: { content: Array<{ type: string; text?: string }> }): string {
		const parts = result.content
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text);
		return parts.join("\n").trim();
	}

	function unwrapToolResult(tool: Agent.AnyAgentTool, result: Agent.ToolTerminalResult<unknown, unknown>): unknown {
		if (result.status === "completed") {
			if (tool.outputSchema) {
				return validateSchema(tool.outputSchema, result.result.details, `Tool "${tool.name}" output`);
			}
			return result.result.details;
		}

		if (tool.errorSchema && result.result.details !== undefined) {
			validateSchema(tool.errorSchema, result.result.details, `Tool "${tool.name}" error`);
		}

		const message = toolContentToText(result.result) || `Tool "${tool.name}" failed`;
		const error = new Error(message);
		if (result.result.details !== undefined) {
			(error as Error & { cause?: unknown }).cause = result.result.details;
		}
		throw error;
	}

	function toolToBinding(tool: Agent.AnyAgentTool, prefix: string = ""): ToolBinding {
		const inputSchema = TypeGuard.IsSchema(tool.parameters) ? tool.parameters : Type.Object({});
		const outputSchema = TypeGuard.IsSchema(tool.outputSchema) ? tool.outputSchema : undefined;
		const errorSchema = TypeGuard.IsSchema(tool.errorSchema) ? tool.errorSchema : undefined;

		if (!("execute" in tool) || typeof tool.execute !== "function") {
			throw new ToolDefinitionErr({
				message: `tool "${tool.name}" does not have an execute function. code mode requires tools with implementation`,
			});
		}

		return {
			name: `${prefix}${tool.name}`,
			description: tool.description,
			inputSchema,
			outputSchema,
			errorSchema,
			execute: async (callID: string, params: unknown, signal?: AbortSignal) => {
				const validatedParams = validateSchema(inputSchema, params, `Tool "${tool.name}" input`);
				const terminalResult = await tool.execute(callID, validatedParams, signal);
				return unwrapToolResult(tool, terminalResult);
			},
		};
	}

	function toolsForBinding(tools: Agent.AnyAgentTool[], prefix: string = ""): Record<string, ToolBinding> {
		const bindings: Record<string, ToolBinding> = {};

		for (const tool of tools) {
			const name = `${prefix}${tool.name}`;
			bindings[name] = toolToBinding(tool, prefix);
		}

		return bindings;
	}

	function indent(value: string, depth: number = 1): string {
		const prefix = "\t".repeat(depth);
		return value
			.split("\n")
			.map((line) => `${prefix}${line}`)
			.join("\n");
	}

	function toPropertyKey(name: string): string {
		return /^[$A-Z_a-z][$\w]*$/i.test(name) ? name : JSON.stringify(name);
	}

	function schemaToTypeScript(schema: TSchema): string {
		if (TypeGuard.IsAny(schema)) return "any";
		if (TypeGuard.IsUnknown(schema)) return "unknown";
		if (TypeGuard.IsString(schema)) return "string";
		if (TypeGuard.IsNumber(schema) || TypeGuard.IsInteger(schema)) return "number";
		if (TypeGuard.IsBoolean(schema)) return "boolean";
		if (TypeGuard.IsNull(schema)) return "null";
		if (TypeGuard.IsUndefined(schema) || TypeGuard.IsVoid(schema)) return "undefined";
		if (TypeGuard.IsLiteral(schema)) return JSON.stringify(schema.const);

		if (TypeGuard.IsArray(schema)) {
			return `Array<${schemaToTypeScript(schema.items)}>`;
		}

		if (TypeGuard.IsTuple(schema)) {
			const items = schema.items ?? [];
			return `[${items.map((item) => schemaToTypeScript(item)).join(", ")}]`;
		}

		if (TypeGuard.IsUnion(schema)) {
			return schema.anyOf.map((item) => schemaToTypeScript(item)).join(" | ");
		}

		if (TypeGuard.IsIntersect(schema)) {
			return schema.allOf.map((item) => schemaToTypeScript(item)).join(" & ");
		}

		if (TypeGuard.IsRecord(schema)) {
			const valueSchema =
				Object.values(schema.patternProperties ?? {}).find(TypeGuard.IsSchema) ??
				(schema.additionalProperties && TypeGuard.IsSchema(schema.additionalProperties)
					? schema.additionalProperties
					: Type.Unknown());
			return `Record<string, ${schemaToTypeScript(valueSchema)}>`;
		}

		if (TypeGuard.IsObject(schema)) {
			const required = new Set(schema.required ?? []);
			const properties = Object.entries(schema.properties ?? {}).map(([key, value]) => {
				const optional = required.has(key) ? "" : "?";
				return `${toPropertyKey(key)}${optional}: ${schemaToTypeScript(value)};`;
			});

			if (schema.additionalProperties === true) {
				properties.push("[key: string]: unknown;");
			} else if (schema.additionalProperties && TypeGuard.IsSchema(schema.additionalProperties)) {
				properties.push(`[key: string]: ${schemaToTypeScript(schema.additionalProperties)};`);
			}

			if (properties.length === 0) return "{}";

			return `{\n${indent(properties.join("\n"))}\n}`;
		}

		return "unknown";
	}

	/**
	 * Generate TypeScript type stubs for all tool bindings.
	 *
	 * These stubs are included in the LLM system prompt so it knows the exact
	 * type signatures of available tools.
	 */
	export function generateTypeStubs(
		bindings: Record<string, ToolBinding>,
		options: TypeGeneratorOptions = {},
	): string {
		const { includeDescriptions = true } = options;
		const declarations: string[] = [];

		for (const [name, binding] of Object.entries(bindings)) {
			const inputTypeName = `${capitalize(name)}Input`;
			const outputTypeName = `${capitalize(name)}Output`;

			declarations.push(`type ${inputTypeName} = ${schemaToTypeScript(binding.inputSchema)};`);

			let outputTypeRef = "unknown";
			if (binding.outputSchema !== undefined) {
				declarations.push(`type ${outputTypeName} = ${schemaToTypeScript(binding.outputSchema)};`);
				outputTypeRef = outputTypeName;
			}

			const description = includeDescriptions && binding.description ? `/** ${binding.description} */\n` : "";
			declarations.push(
				`${description}declare function ${name}(input: ${inputTypeName}): Promise<${outputTypeRef}>;`,
			);
		}

		return declarations.join("\n\n");
	}

	function buildExampleSnippet(): string[] {
		return [
			"```typescript",
			"const numbers = [12, 24, 36];",
			"const total = numbers.reduce((sum, value) => sum + value, 0);",
			"",
			"return {",
			"  count: numbers.length,",
			"  average: total / numbers.length,",
			"};",
			"```",
		];
	}

	export function generateSystemPrompt(config: ToolConfig): string {
		const bindings = toolsForBinding(config.tools, "external_");
		const typeStubs = generateTypeStubs(bindings);
		const functionDocs =
			Object.entries(bindings)
				.map(([name, binding]) => `- \`${name}(input)\`: ${binding.description}`)
				.join("\n") || "- No external APIs available for this run.";

		return [
			"## Code Execution Tool",
			"",
			"You have access to `sandbox_execute_typescript` which runs TypeScript code in a sandboxed environment.",
			"",
			"### When to Use",
			"",
			"Use `sandbox_execute_typescript` when you need to:",
			"- Process data with loops, conditionals, or complex logic",
			"- Make multiple tool calls in parallel with `Promise.all(...)`",
			"- Transform, filter, or aggregate data",
			"- Perform calculations or data analysis",
			"",
			"Prefer direct tool calls outside `sandbox_execute_typescript` when code execution is unnecessary.",
			"",
			"### Available External APIs",
			"",
			"Inside your TypeScript code, you can call these async functions:",
			"",
			functionDocs,
			"",
			"### Type Definitions",
			"",
			"```typescript",
			typeStubs,
			"```",
			"",
			"### Example",
			"",
			...buildExampleSnippet(),
			"",
			"### Important Notes",
			"",
			"- All `external_*` calls are async, so always `await` them",
			"- Use `return` to pass the final value back from the script",
			"- `console.log()`, `console.info()`, `console.warn()`, and `console.error()` are captured",
			"- If an `external_*` call fails, it rejects, so use `try/catch` when needed",
			"- Each execution is isolated and does not share state with previous runs",
			"",
		].join("\n");
	}

	function toMegabytes(value: number | undefined): number {
		return (value ?? DEFAULT_MEMORY_LIMIT_MB) * 1024 * 1024;
	}

	async function transpileTypeScript(typescriptCode: string): Promise<string> {
		const wrappedSource = ["(async () => {", typescriptCode, "})()"].join("\n");
		const transformed = await transform(wrappedSource, {
			loader: "ts",
			format: "esm",
			target: "es2022",
			platform: "neutral",
			sourcefile: "sandbox-user-script.ts",
		});
		return transformed.code;
	}

	function createConsole(vm: QuickJS, logs: string[]) {
		const consoleObject = vm.newObject();
		const methods = [
			["log", ""],
			["info", "INFO: "],
			["warn", "WARN: "],
			["error", "ERROR: "],
		] as const;

		for (const [name, prefix] of methods) {
			const fn = vm.newFunction(name, (...args) => {
				const message = args.map((arg) => String(vm.dump(arg))).join(" ");
				logs.push(`${prefix}${message}`);
				return vm.undefined;
			});
			consoleObject.setProp(name, fn);
		}

		vm.setProp(vm.global, "console", consoleObject);
	}

	function registerBindings(vm: QuickJS, bindings: Record<string, ToolBinding>, signal?: AbortSignal) {
		let callCounter = 0;

		for (const [name, binding] of Object.entries(bindings)) {
			const fn = vm.newFunction(name, (...args) => {
				const input = args[0] ? vm.dump(args[0]) : undefined;
				const result = Promise.resolve(binding.execute(`${name}:${++callCounter}`, input, signal));
				return vm.hostToHandle(result);
			});
			vm.setProp(vm.global, name, fn);
		}
	}

	export function createQuickJSWasiDriver(): Driver {
		return {
			async createContext(config: DriverContextConfig): Promise<Context> {
				const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
				const deadline = Date.now() + timeout;
				const logs: string[] = [];
				const vm = await QuickJS.create({
					memoryLimit: toMegabytes(config.memoryLimit),
					interruptHandler: () => Boolean(config.signal?.aborted) || Date.now() > deadline,
				});

				createConsole(vm, logs);
				registerBindings(vm, config.bindings, config.signal);

				return {
					async execute<T = unknown>(code: string): Promise<ExecutionResult<T>> {
						let resultHandle: ReturnType<typeof vm.evalCode> | undefined;

						try {
							resultHandle = vm.evalCode(code, "sandbox-user-script.js");
							vm.executePendingJobs();

							const settled = await vm.resolvePromise(resultHandle);
							if ("error" in settled) {
								try {
									return {
										success: false,
										error: normalizeExecutionError(vm.dump(settled.error)),
										logs: [...logs],
									};
								} finally {
									settled.error.dispose();
								}
							}

							try {
								return {
									success: true,
									value: vm.dump(settled.value) as T,
									logs: [...logs],
								};
							} finally {
								settled.value.dispose();
							}
						} catch (error) {
							return {
								success: false,
								error: normalizeExecutionError(error),
								logs: [...logs],
							};
						} finally {
							resultHandle?.dispose();
						}
					},
					async dispose() {
						vm.dispose();
					},
				};
			},
		};
	}

	function buildToolDescription(tools: Agent.AnyAgentTool[]): string {
		const externalFunctions = tools.map((tool) => `external_${tool.name}`).join(", ");
		const externalApiText = externalFunctions
			? `Available external APIs: ${externalFunctions}. `
			: "No external APIs are exposed for this run. ";

		return (
			"Execute TypeScript code in a QuickJS-WASI sandbox. " +
			externalApiText +
			"All external_* calls are async and must be awaited. " +
			"Return a value from the script to pass results back."
		);
	}

	export function createTool(
		config: ToolConfig,
	): Agent.AgentTool<
		typeof SandboxExecutionInputSchema,
		typeof SandboxExecutionOutputSchema,
		unknown,
		typeof SandboxExecutionErrorSchema
	> {
		return Agent.defineTool({
			name: "sandbox_execute_typescript",
			label: "Sandbox TypeScript",
			description: buildToolDescription(config.tools),
			parameters: SandboxExecutionInputSchema,
			outputSchema: SandboxExecutionOutputSchema,
			errorSchema: SandboxExecutionErrorSchema,
			async execute(callID, params, signal, onUpdate) {
				const bindings = toolsForBinding(config.tools, "external_");
				let context: Context | undefined;

				try {
					await onUpdate?.({
						status: "running",
						partial: {
							content: [{ type: "text", text: "Transpiling TypeScript for sandbox execution" }],
						},
					});

					const javascriptCode = await transpileTypeScript(params.typescriptCode);

					await onUpdate?.({
						status: "running",
						partial: {
							content: [{ type: "text", text: "Executing code in QuickJS-WASI sandbox" }],
						},
					});

					context = await config.driver.createContext({
						bindings,
						timeout: config.timeout,
						memoryLimit: config.memoryLimit,
						signal,
					});

					const executionResult = await context.execute(javascriptCode);
					if (executionResult.success) {
						const details: SandboxExecutionOutput = {
							result: executionResult.value,
							...(executionResult.logs && executionResult.logs.length > 0 ? { logs: executionResult.logs } : {}),
						};

						return {
							status: "completed",
							result: {
								content: [{ type: "text", text: serializeForContent(details) }],
								details,
								isError: false,
							},
						};
					}

					const details: SandboxExecutionError = {
						message: executionResult.error?.message || "Sandbox execution failed",
						...(executionResult.error?.name ? { name: executionResult.error.name } : {}),
						...(executionResult.error?.stack ? { stack: executionResult.error.stack } : {}),
						...(executionResult.error?.line != null ? { line: executionResult.error.line } : {}),
						...(executionResult.logs && executionResult.logs.length > 0 ? { logs: executionResult.logs } : {}),
					};

					return {
						status: "error",
						result: {
							content: [{ type: "text", text: serializeForContent(details) }],
							details,
							isError: true,
						},
					};
				} catch (error) {
					const normalizedError = normalizeExecutionError(error);
					const details: SandboxExecutionError = {
						message: normalizedError.message,
						...(normalizedError.name ? { name: normalizedError.name } : {}),
						...(normalizedError.stack ? { stack: normalizedError.stack } : {}),
						...(normalizedError.line != null ? { line: normalizedError.line } : {}),
					};

					return {
						status: "error",
						result: {
							content: [{ type: "text", text: serializeForContent(details) }],
							details,
							isError: true,
						},
					};
				} finally {
					await context?.dispose();
				}
			},
		});
	}

	export async function create(config: ToolConfig) {
		return {
			tool: createTool(config),
			systemPrompt: generateSystemPrompt(config),
		};
	}
}
