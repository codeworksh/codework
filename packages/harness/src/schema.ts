import { Message } from "@codeworksh/aikit";
import { Option, Schema, SchemaGetter, DateTime } from "effect";
import type { Static, TSchema } from "typebox";
import TypeBoxSchema from "typebox/schema";

const aikitValidators = new WeakMap<TSchema, ReturnType<typeof TypeBoxSchema.Compile>>();

const aikitValidatorFor = <T extends TSchema>(schema: T): ReturnType<typeof TypeBoxSchema.Compile<T>> => {
	const cached = aikitValidators.get(schema) as ReturnType<typeof TypeBoxSchema.Compile<T>> | undefined;
	if (cached !== undefined) return cached;
	const compiled = TypeBoxSchema.Compile(schema);
	aikitValidators.set(schema, compiled);
	return compiled;
};

const aikitErrorPath = (error: {
	readonly instancePath?: string;
	readonly params?: Record<string, unknown>;
}): string => {
	if (error.instancePath) return error.instancePath.substring(1);
	const required = error.params?.requiredProperties;
	return Array.isArray(required) ? required.join(", ") : "root";
};

const validateAikitSchema = <T extends TSchema>(schema: T, value: unknown, label: string): Static<T> => {
	const validator = aikitValidatorFor(schema);
	if (validator.Check(value)) return value;

	const [, issues] = validator.Errors(value);
	const details =
		issues.map((issue) => ` - ${aikitErrorPath(issue)}: ${issue.message}`).join("\n") || "Unknown error";
	throw new Error(`Validation Failed For ${label}\n${details}`);
};

/** Validate an aikit message without coercing or rewriting durable data. */
export const validateAikitMessage = (value: unknown, label: string): Message.Message =>
	validateAikitSchema(Message.MessageSchema, value, label);

export const validateAikitUserMessage = (value: unknown, label: string): Message.UserMessage =>
	validateAikitSchema(Message.UserMessageSchema, value, label);

export const validateAikitAssistantMessage = (value: unknown, label: string): Message.AssistantMessage =>
	validateAikitSchema(Message.AssistantMessageSchema, value, label);

export const isAikitAssistantMessage = (value: unknown): value is Message.AssistantMessage =>
	aikitValidatorFor(Message.AssistantMessageSchema).Check(value);

/**
 * Integer greater than zero.
 */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * Integer greater than or equal to zero.
 */
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Cost greater than or equal with finite value
 */
export const NonNegativeCost = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Relative file path (e.g., `src/components/Button.tsx`).
 */
export const RelativePath = Schema.String.pipe(Schema.brand("RelativePath"));
export type RelativePath = Schema.Schema.Type<typeof RelativePath>;

/**
 * Absolute file path (e.g., `/home/user/projects/myapp/src/main.ts`).
 */
export const AbsolutePath = Schema.String.pipe(Schema.brand("AbsolutePath"));
export type AbsolutePath = Schema.Schema.Type<typeof AbsolutePath>;

/**
 * Optional public JSON field that can hold explicit `undefined` on the type
 * side but encodes it as an omitted key, matching legacy `JSON.stringify`.
 */
export const optional = <S extends Schema.Top>(schema: S) =>
	Schema.optionalKey(schema).pipe(
		Schema.decodeTo(Schema.optional(schema), {
			decode: SchemaGetter.passthrough({ strict: false }),
			encode: SchemaGetter.transformOptional(Option.filter((value) => value !== undefined)),
		}),
	);

/**
 * Strip `readonly` from a nested type. Stand-in for `effect`'s `Types.DeepMutable`
 * until `effect:core/x228my` ("Types.DeepMutable widens unknown to `{}`") lands.
 *
 * The upstream version falls through `unknown` into `{ -readonly [K in keyof T]: ... }`
 * where `keyof unknown = never`, so `unknown` collapses to `{}`. This local
 * version gates the object branch on `extends object` (which `unknown` does
 * not) so `unknown` passes through untouched.
 *
 * Primitive bailout matches upstream — without it, branded strings like
 * `string & Brand<"SessionID">` fall into the object branch and get their
 * prototype methods walked.
 *
 * Tuple branch preserves readonly tuples (e.g. `ConfigPlugin.Spec`'s
 * `readonly [string, Options]`); the general array branch would otherwise
 * widen them to unbounded arrays.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type DeepMutable<T> = T extends string | number | boolean | bigint | symbol | Function
	? T
	: T extends readonly [unknown, ...unknown[]]
		? { -readonly [K in keyof T]: DeepMutable<T[K]> }
		: T extends readonly (infer U)[]
			? DeepMutable<U>[]
			: T extends object
				? { -readonly [K in keyof T]: DeepMutable<T[K]> }
				: T;

/**
 * Attach static methods to a schema object. Designed to be used with `.pipe()`:
 *
 * @example
 *   export const Foo = fooSchema.pipe(
 *     withStatics((schema) => ({
 *       zero: schema.make(0),
 *       from: Schema.decodeUnknownOption(schema),
 *     }))
 *   )
 */
export const withStatics =
	<S extends object, M extends Record<string, unknown>>(methods: (schema: S) => M) =>
	(schema: S): S & M =>
		Object.assign(schema, methods(schema));

/**
 * Nominal wrapper for scalar types. The class itself is a valid schema —
 * pass it directly to `Schema.decode`, `Schema.decodeEffect`, etc.
 *
 * Overrides `~type.make` on the derived `Schema.Opaque` so `Schema.Schema.Type`
 * of a field using this newtype resolves to `Self` rather than the underlying
 * branded phantom. Without that override, passing a class instance to code
 * typed against `Schema.Schema.Type<FieldSchema>` would require a cast even
 * though the values are structurally equivalent at runtime.
 *
 * @example
 *   class QuestionID extends Newtype<QuestionID>()("QuestionID", Schema.String) {
 *     static make(id: string): QuestionID {
 *       return this.make(id)
 *     }
 *   }
 *
 *   Schema.decodeEffect(QuestionID)(input)
 */
export function Newtype<Self>() {
	return <const Tag extends string, S extends Schema.Top>(tag: Tag, schema: S) => {
		abstract class Base {
			declare readonly _newtype: Tag;

			static make(value: Schema.Schema.Type<S>): Self {
				return value as unknown as Self;
			}
		}

		Object.setPrototypeOf(Base, schema);

		return Base as unknown as (abstract new (_: never) => { readonly _newtype: Tag }) & {
			readonly make: (value: Schema.Schema.Type<S>) => Self;
		} & Omit<Schema.Opaque<Self, S, {}>, "make" | "~type.make"> & {
				readonly "~type.make": Self;
			};
	};
}


export const DateTimeUtcFromMillis = Schema.Finite.pipe(
	Schema.decodeTo(Schema.DateTimeUtc, {
	  decode: SchemaGetter.transform((value) => DateTime.makeUnsafe(value)),
	  encode: SchemaGetter.transform((value) => DateTime.toEpochMillis(value)),
	}),
  )
