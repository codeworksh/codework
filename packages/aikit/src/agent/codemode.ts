import { NamedError } from "@codeworksh/utils";
import { type TSchema, Type, TypeGuard } from "@sinclair/typebox";
import { capitalize } from "remeda";
import type { Agent } from "./agent";

export namespace CodeMode {
	export const ToolDefinitionErr = NamedError.create(
		"ToolDefinitionErr",
		Type.Object({
			message: Type.String(),
		}),
	);

	export interface Driver {}

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
		 * Execution timeout in milliseconds (default: 3000)
		 */
		timeout?: number;
		/**
		 * Memory limit in MB for sandbox (default: 3000)
		 */
		memoryLimit?: number;
	}

	export interface ToolBinding {
		name: string;
		description: string;
		inputSchema: TSchema;
		outputSchema?: TSchema;
		execute: (
			callID: string,
			params: unknown,
			signal?: AbortSignal,
			onUpdate?: Agent.ToolUpdateCallback,
		) => Promise<unknown>;
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

	function toolToBinding(tool: Agent.AnyAgentTool, prefix: string = ""): ToolBinding {
		const inputSchema = TypeGuard.IsSchema(tool.parameters) ? tool.parameters : Type.Object({});
		const outputSchema = TypeGuard.IsSchema(tool.outputSchema) ? tool.outputSchema : undefined;
		let execute: (
			callID: string,
			params: unknown,
			signal?: AbortSignal,
			onUpdate?: Agent.ToolUpdateCallback,
		) => Promise<unknown>;

		if ("execute" in tool && typeof tool.execute === "function") {
			const toolExecute = tool.execute;
			execute = (callID: string, params: unknown, signal?: AbortSignal, onUpdate?: Agent.ToolUpdateCallback) => {
				return Promise.resolve(toolExecute(callID, params, signal, onUpdate));
			};
		} else {
			throw new ToolDefinitionErr({
				message: `tool "${tool.name}" does not have an execute function. code mode requires tools with implementation`,
			});
		}

		return {
			name: `${prefix}${tool.name}`,
			description: tool.description,
			inputSchema,
			outputSchema,
			execute,
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
	 * Generate TypeScript type stubs for all tool bindings
	 *
	 * These stubs are included in the LLM system prompt so it knows
	 * the exact type signatures of available tools.
	 *
	 * Tool names match the actual function names injected into the sandbox.
	 */
	export function generateTypeStubs(
		bindings: Record<string, ToolBinding>,
		options: TypeGeneratorOptions = {},
	): string {
		const { includeDescriptions = true } = options;
		const declarations: Array<string> = [];

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
	function generateSystemPrompt(config: ToolConfig): string {
		const { tools } = config;
		// transform tools to bindings with external_ prefix to generate correct type stubs
		const bindings = toolsForBinding(tools, "external_");

		// generate TypeScript type stubs for the external functions
		const typeStubs = generateTypeStubs(bindings);
		// Build function documentation
		const functionDocs = Object.entries(bindings)
			.map(([name, binding]) => {
				const doc = `- \`${name}(input)\`: ${binding.description}`;
				return doc;
			})
			.join("\n");

		return [
			"## Code Execution Tool",
			"",
			"You have access to `sandbox_execute_typescript` which runs TypeScript code in a sandboxed environment.",
			"",
			"### When to Use",
			"",
			"Use `sandbox_execute_typescript` when you need to:",
			"- Process data with loops, conditionals, or complex logic",
			"- Make multiple API calls in parallel (Promise.all)",
			"- Transform, filter, or aggregate data",
			"- Perform calculations or data analysis",
			"",
			"For simple operations, prefer calling tools directly.",
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
			"```typescript",
			"// Fetch weather for multiple cities in parallel",
			'const cities = ["Tokyo", "Paris", "NYC"];',
			"const results = await Promise.all(",
			"  cities.map(city => external_fetchWeather({ location: city }))",
			");",
			"",
			"// Find the warmest city",
			"const warmest = results.reduce((prev, curr) =>",
			"  curr.temperature > prev.temperature ? curr : prev",
			");",
			"",
			"return { warmestCity: warmest.location, temperature: warmest.temperature };",
			"```",
			"",
			"### Important Notes",
			"",
			"- All `external_*` calls are async - always use `await`",
			"- Return a value to pass results back to you",
			"- Use `console.log()` for debugging (logs are captured)",
			// "- The sandbox is isolated - no network access or file system",
			"- Each execution is independent (no shared state between calls)",
			"",
		].join("\n");
	}

	export async function create(config: ToolConfig) {
		return {
			systemPrompt: generateSystemPrompt(config),
		};
	}
}
