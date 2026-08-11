import { Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { withStatics } from "../schema.ts";

export const ID = Schema.String.pipe(
	Schema.brand("SandboxInstance.ID"),
	withStatics((schema) => ({
		create: () => schema.make(`evt_${uuidv7()}`),
	})),
);
export type ID = typeof ID.Type;

export type Definition<
	Type extends string = string,
	DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> = Schema.Top & {
	readonly type: Type;
	readonly durable?: {
		readonly version: number; // event versioning for decoding in later time
		readonly aggregate: string;
	};
	readonly data: DataSchema;
};

export type Data<D extends Definition> = Schema.Schema.Type<D["data"]>;

export type Payload<D extends Definition = Definition> = {
	readonly id: ID;
	readonly type: D["type"];
	readonly data: Data<D>;
	readonly durable?: {
		readonly aggregateID: string;
		readonly seq: number;
		readonly version: number;
	};
	readonly metadata?: Record<string, unknown>;
};

export * as EventSchema from "./schema.ts";
