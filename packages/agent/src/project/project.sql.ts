import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Timestamps } from "../storage/schema.sql.ts";

export const ProjectTable = sqliteTable("project", {
	id: text("id").primaryKey(),
	worktree: text("worktree").notNull().default("/"),
	vcs: text("vcs"),
	repo: text("repo"),
	name: text("name"),
	iconUrl: text("icon_url"),
	iconColor: text("icon_color"),
	initializedAt: integer("initialized_at"),
	...Timestamps,
});
