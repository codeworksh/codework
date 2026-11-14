import { Schema } from "effect";
import { NonNegativeInt, optional } from "../schema.ts";
import * as SessionSchema from "../session/schema.ts";

/** What the rollup reads of a finalised assistant envelope. `reasoning` is a subset of `output`. */
export const Assistant = Schema.fromJsonString(
	Schema.Struct({
		provider: Schema.Struct({ id: Schema.String }),
		model: Schema.String,
		thinkingLevel: Schema.String,
		usage: Schema.Struct({ ...SessionSchema.Usage.fields, reasoning: optional(NonNegativeInt) }),
		time: Schema.Struct({ created: Schema.Finite, completed: optional(Schema.Finite) }),
	}),
);

/** What the rollup reads of a committed user envelope. */
export const User = Schema.fromJsonString(Schema.Struct({ time: Schema.Struct({ created: Schema.Finite }) }));

/**
 * Upper bounds in ms of the request duration histogram, log-spaced from 250 ms to 30 min: bucket `i`
 * counts durations below `edges[i]` and at or above `edges[i - 1]`; one more bucket past the last edge
 * is open-ended. Medians and percentiles read from it are accurate to a bucket. Persisted counts are
 * positional, so the edges are frozen.
 */
export const edges = [
	250, 374, 561, 839, 1257, 1882, 2818, 4220, 6318, 9461, 14167, 21213, 31764, 47563, 71221, 106645, 159688, 239115,
	358046, 536133, 802797, 1202096, 1800000,
] as const;

export const Durations = Schema.fromJsonString(Schema.Array(NonNegativeInt));

export const tallyKinds = ["prompt", "tool"] as const;
export type TallyKind = (typeof tallyKinds)[number];
