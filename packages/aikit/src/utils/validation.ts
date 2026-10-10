/**
 * @description Validation powered by TypeBox's built-in schema compiler.
 */

import type { Static, TSchema } from "typebox";
import Schema from "typebox/schema";
import Value from "typebox/value";

import { nullableVariant, schemaAllowsNull } from "../llm/strict.ts";
import type * as Message from "../message/message.ts";

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

type JsonSchemaObject = {
	properties?: Record<string, JsonSchemaObject>;
	required?: string[];
	items?: JsonSchemaObject | JsonSchemaObject[];
	$ref?: unknown;
};

/**
 * Drop `null` from optional properties whose schema does not accept null, in place. Strict constrained sampling
 * makes every property required and nullable, so the model answers an omitted optional argument with `null`.
 */
export function normalizeOptionalNulls(value: unknown, schema: unknown): void {
	const variant = nullableVariant(schema);
	if (variant !== undefined) return normalizeOptionalNulls(value, variant);
	const node = schema as JsonSchemaObject;
	if (Array.isArray(value)) {
		if (Array.isArray(node.items)) {
			for (const [index, item] of value.entries()) {
				if (node.items[index]) normalizeOptionalNulls(item, node.items[index]);
			}
		} else if (node.items) {
			for (const item of value) normalizeOptionalNulls(item, node.items);
		}
		return;
	}
	if (typeof value !== "object" || value === null || !node.properties) return;

	const object = value as Record<string, unknown>;
	const required = new Set(node.required ?? []);
	for (const [key, property] of Object.entries(node.properties)) {
		if (!(key in object)) continue;
		if (
			object[key] === null &&
			!required.has(key) &&
			typeof property.$ref !== "string" &&
			!schemaAllowsNull(property)
		) {
			delete object[key];
		} else {
			normalizeOptionalNulls(object[key], property);
		}
	}
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
	toolExecution: Message.ToolCallInFlight,
): Message.ToolArguments<T> {
	const tool = tools.find((t) => t.name === toolExecution.name);
	if (!tool) {
		throw new Error(`tool "${toolExecution.name}" not found`);
	}
	return validateToolArguments(tool, toolExecution);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 */
export function validateToolArguments<T extends Message.Tool>(
	tool: T,
	toolExecution: Message.ToolCallInFlight,
): Message.ToolArguments<T> {
	const args = structuredClone(toolExecution.rawArgs);
	normalizeOptionalNulls(args, tool.parameters);
	return validateSchema(tool.parameters, args, `Tool "${toolExecution.name}"`) as Message.ToolArguments<T>;
}
