/**
 * @description Validation powered by ajv, TypeBox natively doesn't provide data validation.
 */

import type { Static, TSchema } from "@sinclair/typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import type { Agent } from "../agent/agent";
import type { Message } from "../message/message";

// Create singleton AJV instance with formats
const ajv = new Ajv({
	allErrors: true,
	strict: false,
	coerceTypes: true,
});
addFormats(ajv);

/**
 * Validates an arbitrary value against a TypeBox schema and returns the coerced value.
 */
export function validateSchema<T extends TSchema>(schema: T, value: unknown, label: string): Static<T> {
	const validate = ajv.compile(schema);
	const input = structuredClone(value);

	if (validate(input)) {
		return input as Static<T>;
	}

	const errors =
		validate.errors
			?.map((err) => {
				const path = err.instancePath ? err.instancePath.substring(1) : err.params?.missingProperty || "root";
				return ` - ${path}: ${err.message}`;
			})
			.join("\n") || "Unknown Validation Error";

	throw new Error(
		[`Validation Failed For ${label}`, `${errors}\n`, "Received Value:", `${JSON.stringify(value, null, 2)}\n`].join(
			"\n",
		),
	);
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
