import { Schema } from "effect";
import { v7 as uuidv7 } from "uuid";
import { withStatics } from "../schema";

export const ID = Schema.String.check(Schema.isStartsWith("wrk")).pipe(
	Schema.brand("Workspace.ID"),
	withStatics((schema) => ({
		ascending: (id?: string) => {
			if (!id) return schema.make("wrk_" + uuidv7());
			if (!id.startsWith("wrk")) throw new Error(`ID ${id} does not start with wrk`);
			return schema.make(id);
		},
		create: () => schema.make("wrk_" + uuidv7()),
	})),
);
export type ID = typeof ID.Type;

export * as Workspace from "./workspace";
