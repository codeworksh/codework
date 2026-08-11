import Type, { type TUnsafe } from "typebox";

/**
 * `T` with every `undefined`-valued key turned into an optional key.
 */
type Compact<T> = {
	[K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
	[K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/**
 * Drops keys whose value is `undefined`.
 *
 * Under `exactOptionalPropertyTypes` an explicit `undefined` is not assignable to an optional
 * property, so a literal built from optional inputs has to omit the key rather than pass it
 * through. Only worth reaching for when a literal forwards many optional values at once — for a
 * handful of keys a conditional spread reads better.
 */
export function compact<T extends object>(value: T): Compact<T> {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) result[key] = entry;
	}
	return result as Compact<T>;
}

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as any,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
