import type { Static, TSchema } from "typebox";
import Value from "typebox/value";

export function fn<T extends TSchema, Result>(schema: T, cb: (input: Static<T>) => Result) {
	const result = (input: unknown) => {
		let parsed: Static<T>;
		try {
			parsed = Value.Parse(schema, input);
		} catch (e) {
			console.trace("schema validation failure stack trace:");
			throw e;
		}

		return cb(parsed);
	};

	result.force = (input: Static<T>) => cb(input);
	result.schema = schema;

	return result;
}
