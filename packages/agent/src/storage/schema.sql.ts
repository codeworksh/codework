import { integer } from "drizzle-orm/sqlite-core";

export const Timestamps = {
	createdAt: integer("created_at")
		.notNull()
		.$default(() => Date.now()),
	updatedAt: integer("updated_at")
		.notNull()
		.$onUpdate(() => Date.now()),
};
