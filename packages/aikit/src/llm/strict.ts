import type * as Message from "../message/message.ts";
import * as Model from "../model/model.ts";

type JsonSchemaObject = Record<string, unknown> & {
	properties?: Record<string, unknown>;
	required?: unknown;
};

class UnsupportedStrictSchemaError extends Error {}

/** True when a provider's strict mode rejects this schema keyword with this value. */
type UnsupportedKeyword = (key: string, value: unknown) => boolean;

const UNSUPPORTED_KEYWORDS = [
	"$ref",
	"$defs",
	"definitions",
	"allOf",
	"oneOf",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"unevaluatedProperties",
	"propertyNames",
	"contains",
	"prefixItems",
	"not",
	"if",
	"then",
	"else",
] as const;

// Anthropic strict tool use rejects these with a 400 for the whole request.
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
const ANTHROPIC_UNSUPPORTED_KEYWORDS = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"maxItems",
	"uniqueItems",
	"minContains",
	"maxContains",
	"minProperties",
	"maxProperties",
]);
const ANTHROPIC_STRING_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);

const isAnthropicUnsupportedKeyword: UnsupportedKeyword = (key, value) => {
	if (ANTHROPIC_UNSUPPORTED_KEYWORDS.has(key)) return true;
	if (key === "minItems") return value !== 0 && value !== 1;
	if (key === "format") return typeof value !== "string" || !ANTHROPIC_STRING_FORMATS.has(value);
	return false;
};

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullSchema(schema: unknown): boolean {
	return isJsonSchemaObject(schema) && schema.type === "null";
}

/** `X` of an `anyOf: [X, null]` schema. */
export function nullableVariant(schema: unknown): unknown {
	if (!isJsonSchemaObject(schema) || !Array.isArray(schema.anyOf)) return;
	const variants = schema.anyOf.filter((variant) => !isNullSchema(variant));
	return variants.length === 1 ? variants[0] : undefined;
}

function isStructuredSchema(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema)) return false;
	const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
	return (
		types.includes("object") ||
		types.includes("array") ||
		schema.properties !== undefined ||
		schema.items !== undefined
	);
}

const CONSTRAINING_KEYWORDS = [
	"type",
	"const",
	"enum",
	"anyOf",
	"allOf",
	"oneOf",
	"not",
	"$ref",
	"properties",
	"items",
];

export function schemaAllowsNull(schema: unknown): boolean {
	if (schema === true) return true;
	if (!isJsonSchemaObject(schema)) return false;
	if (CONSTRAINING_KEYWORDS.every((key) => schema[key] === undefined)) return true;
	if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) return true;
	if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))) return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some((variant) => schemaAllowsNull(variant));
}

function makeNodeStrict(schema: unknown, isUnsupportedKeyword?: UnsupportedKeyword): void {
	if (!isJsonSchemaObject(schema)) throw new UnsupportedStrictSchemaError("boolean schemas are unsupported");
	for (const key of UNSUPPORTED_KEYWORDS) {
		if (schema[key] !== undefined) throw new UnsupportedStrictSchemaError(`${key} schemas are unsupported`);
	}
	if (isUnsupportedKeyword) {
		for (const [key, value] of Object.entries(schema)) {
			if (isUnsupportedKeyword(key, value)) {
				throw new UnsupportedStrictSchemaError(`${key}: ${JSON.stringify(value)} is unsupported`);
			}
		}
	}

	if (schema.anyOf !== undefined) {
		if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
			throw new UnsupportedStrictSchemaError("anyOf must contain at least one schema");
		}
		// `[X, null]` is the nullable shape this transform itself emits; only real unions of structures are rejected.
		const nullable = nullableVariant(schema) !== undefined;
		for (const variant of schema.anyOf) {
			if (!nullable && isStructuredSchema(variant)) {
				throw new UnsupportedStrictSchemaError("object and array unions are unsupported");
			}
			makeNodeStrict(variant, isUnsupportedKeyword);
		}
	}

	if (schema.items !== undefined) {
		if (Array.isArray(schema.items)) throw new UnsupportedStrictSchemaError("tuple schemas are unsupported");
		makeNodeStrict(schema.items, isUnsupportedKeyword);
	}

	const isObjectSchema = schema.type === "object";
	if (schema.properties !== undefined && !isObjectSchema) {
		throw new UnsupportedStrictSchemaError("properties require type object");
	}
	if (!isObjectSchema) return;
	// Effect Schema emits `additionalProperties: true` for every struct; excess keys are dropped on decode, so
	// closing the object loses nothing. Only schema-valued additionalProperties carries meaning.
	if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
		throw new UnsupportedStrictSchemaError("schema-valued additionalProperties is unsupported");
	}
	if (schema.properties !== undefined && !isJsonSchemaObject(schema.properties)) {
		throw new UnsupportedStrictSchemaError("object properties must be a schema map");
	}
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))
	) {
		throw new UnsupportedStrictSchemaError("object required must be a string array");
	}

	const properties = schema.properties ?? {};
	const propertyNames = Object.keys(properties);
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	if ([...required].some((key) => !propertyNames.includes(key))) {
		throw new UnsupportedStrictSchemaError("required contains an unknown property");
	}
	for (const [key, property] of Object.entries(properties)) {
		makeNodeStrict(property, isUnsupportedKeyword);
		if (!required.has(key) && !schemaAllowsNull(property)) {
			properties[key] = { anyOf: [property, { type: "null" }] };
		}
	}
	schema.required = propertyNames;
	schema.additionalProperties = false;
}

/**
 * Convert a tool's parameter schema to the subset strict constrained sampling accepts: every object closed and
 * every property required, with formerly optional properties made nullable. Callers strip those nulls again
 * before validation (see `normalizeOptionalNulls`).
 */
function makeStrictJsonSchema(schema: unknown, isUnsupportedKeyword?: UnsupportedKeyword): Record<string, unknown> {
	const cloned: unknown = structuredClone(schema);
	if (!isJsonSchemaObject(cloned) || cloned.type !== "object") {
		throw new UnsupportedStrictSchemaError("root schema must have type object");
	}
	makeNodeStrict(cloned, isUnsupportedKeyword);
	return cloned;
}

/**
 * The strict parameter schema to send for a JSON-schema constrained tool, or `undefined` to send it non-strict.
 * A `"prefer"` tool whose schema the model's strict mode cannot express falls back to non-strict; a `"require"`
 * tool throws instead.
 */
export function resolveStrictParameters(
	tool: Message.Tool,
	model?: Pick<Model.Info, "protocol" | "compat">,
): Record<string, unknown> | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "json_schema") return;

	if (model?.compat?.supportsStrictMode ?? true) {
		const isAnthropic =
			model?.protocol === Model.KnownProviderEnum.anthropic ||
			model?.protocol === Model.KnownProviderEnum.googleVertexAnthropic;
		try {
			return makeStrictJsonSchema(tool.parameters, isAnthropic ? isAnthropicUnsupportedKeyword : undefined);
		} catch (error) {
			if (!(error instanceof UnsupportedStrictSchemaError)) throw error;
			if (config.strict !== "require") return;
			throw new Error(`tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`);
		}
	}
	if (config.strict === "require") {
		throw new Error(
			`tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`,
		);
	}
}
