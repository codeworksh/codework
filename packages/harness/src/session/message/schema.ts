import { Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { withStatics } from "../../schema.ts";



export const ID = Schema.String.check(Schema.isStartsWith("msg_")).pipe(
	Schema.brand("Message.ID"),
	withStatics((schema) => ({
		ascending: (id?: string) => {
			    if (!id) return schema.make("msg_" + uuidv7());
			if (!id.startsWith("msg_")) throw new Error(`ID ${id} does not start with msg_`);
			return schema.make(id);
		},
		create: () => schema.make("msg_" + uuidv7()),
	})),
);
export type ID = typeof ID.Type;

export * as SessionMessageSchema from "./schema.ts";