/**
 * @description Validation powered by TypeBox's built-in schema compiler.
 */

import type { Static, TSchema } from "typebox";
import Schema from "typebox/schema";
import Value from "typebox/value";

import type { Agent } from "../agent/agent";
import type { Message } from "../message/message";

const validators = new WeakMap<TSchema, ReturnType<typeof Schema.Compile>>();

function getValidator<T extends TSchema>(schema: T): ReturnType<typeof Schema.Compile<T>> {
	const existing = validators.get(schema) as ReturnType<typeof Schema.Compile<T>> | undefined;
	if (existing) return existing;

	const validator = Schema.Compile(schema);
	validators.set(schema, validator);
	return validator;
}

function errorPath(error: { instancePath?: string; params?: Record<string, unknown> }): string {
	if (error.instancePath) return error.instancePath.substring(1);

	const requiredProperties = error.params?.requiredProperties;
	if (Array.isArray(requiredProperties)) return requiredProperties.join(", ");

	return "root";
}

/**
 * Validates an arbitrary value against a TypeBox schema and returns the coerced value.
 */
export function validateSchema<T extends TSchema>(schema: T, value: unknown, label: string): Static<T> {
	const validator = getValidator(schema);
	const input = Value.Convert(schema, structuredClone(value));

	try {
		return validator.Parse(input);
	} catch {
		const [_result, validationErrors] = validator.Errors(input);
		const errors =
			validationErrors
				.map((err) => {
					return ` - ${errorPath(err)}: ${err.message}`;
				})
				.join("\n") || "Unknown Validation Error";

		throw new Error(
			[
				`Validation Failed For ${label}`,
				`${errors}\n`,
				"Received Value:",
				`${JSON.stringify(value, null, 2)}\n`,
			].join("\n"),
		);
	}
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 */
export function validateToolCall<T extends Message.Tool>(
	tools: T[],
	toolExecution: Agent.ToolCallInFlight,
): Message.ToolArguments<T> {
	const tool = tools.find((t) => t.name === toolExecution.name);
	if (!tool) {
		throw new Error(`Tool "${toolExecution.name}" not found`);
	}
	return validateToolArguments(tool, toolExecution);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 */
export function validateToolArguments<T extends Message.Tool>(
	tool: T,
	toolExecution: Agent.ToolCallInFlight,
): Message.ToolArguments<T> {
	return validateSchema(
		tool.parameters,
		toolExecution.rawArgs,
		`Tool "${toolExecution.name}"`,
	) as Message.ToolArguments<T>;
}
