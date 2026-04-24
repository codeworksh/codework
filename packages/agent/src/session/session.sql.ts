import { type AnySQLiteColumn, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { ProjectTable } from "../project/project.sql";
import { Timestamps } from "../storage/schema.sql";
import type { Message } from "./message";

type InfoData = Omit<Message.Info, "id" | "sessionID" | "parentMessageID">;
type PartData = Omit<Message.Part, "partID" | "sessionID" | "messageID">;



export const SessionTable = sqliteTable(
	"session",
	{
		id: text("id").primaryKey(),
		projectID: text("project_id")
			.notNull()
			.references(() => ProjectTable.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		parentSessionID: text("parent_session_id").references((): AnySQLiteColumn => SessionTable.id, {
			onDelete: "set null",
			onUpdate: "cascade",
		}),
		activeLeafMessageID: text("active_leaf_message_id").references((): AnySQLiteColumn => MessageTable.id, {
			onDelete: "set null",
			onUpdate: "cascade",
		}),
		cwd: text("cwd").notNull(),
		name: text("name"),
		version: integer("version").notNull().default(1),
		...Timestamps,
	},
	(table) => [
		index("session_project_idx").on(table.projectID),
		index("session_parent_session_idx").on(table.parentSessionID),
		index("session_active_leaf_message_idx").on(table.activeLeafMessageID),
	],
);

export const MessageTable = sqliteTable(
	"message",
	{
		id: text().primaryKey(),
		sessionID: text("session_id")
			.notNull()
			.references(() => SessionTable.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		parentMessageID: text("parent_message_id").references((): AnySQLiteColumn => MessageTable.id, {
			onDelete: "set null",
			onUpdate: "cascade",
		}),
		intent: text("intent").notNull().$type<Message.MessageIntent>(),
		...Timestamps,
		data: text({ mode: "json" }).notNull().$type<InfoData>(),
	},
	(table) => [
		index("message_session_idx").on(table.sessionID),
		index("message_intent_idx").on(table.intent),
		index("message_parent_message_idx").on(table.parentMessageID),
		index("message_session_parent_message_idx").on(table.sessionID, table.parentMessageID),
	],
);

export const PartTable = sqliteTable(
	"part",
	{
		id: text().primaryKey(),
		messageID: text("message_id")
			.notNull()
			.references(() => MessageTable.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		sessionID: text("session_id").notNull(),
		...Timestamps,
		data: text({ mode: "json" }).notNull().$type<PartData>(),
	},
	(table) => [index("part_message_idx").on(table.messageID), index("part_session_idx").on(table.sessionID)],
);
