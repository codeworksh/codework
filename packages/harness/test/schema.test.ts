import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { optional } from "../src/schema.ts";

const Nested = Schema.Struct({
	value: optional(
		Schema.Struct({
			providerResourceId: Schema.OptionFromNullOr(Schema.String),
			createdAt: Schema.DateFromString,
		}),
	),
});

describe("optional codec", () => {
	it.each([null, "remote-instance"])("round-trips nested transforms with provider ID %s", (providerResourceId) =>
		Effect.gen(function* () {
			const wire = { value: { providerResourceId, createdAt: "2026-09-15T00:00:00.000Z" } };
			const decoded = yield* Schema.decodeEffect(Nested)(wire);
			expect(decoded.value?.providerResourceId).toEqual(Option.fromNullishOr(providerResourceId));
			expect(decoded.value?.createdAt).toEqual(new Date(wire.value.createdAt));
			expect(yield* Schema.encodeEffect(Nested)(decoded)).toEqual(wire);
		}).pipe(Effect.runPromise),
	);

	it("preserves omission and removes explicit undefined when encoding", () =>
		Effect.gen(function* () {
			expect(yield* Schema.decodeEffect(Nested)({})).toEqual({});
			expect(yield* Schema.encodeEffect(Nested)({})).toEqual({});
			expect(yield* Schema.encodeEffect(Nested)({ value: undefined })).toEqual({});
		}).pipe(Effect.runPromise));
});
