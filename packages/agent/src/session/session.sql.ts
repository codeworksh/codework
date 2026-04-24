import { type AnySQLiteColumn, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { ProjectTable } from "../project/project.sql";
import { Timestamps } from "../storage/schema.sql";
import type { Message } from "./message";


export const SessionTable = sqliteTable(
	"session",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => ProjectTable.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		parentSessionId: text("parent_session_id").references((): AnySQLiteColumn => SessionTable.id, {
			onDelete: "set null",
			onUpdate: "cascade",
		}),
		activeLeafMessageId: text("active_leaf_message_id").references((): AnySQLiteColumn => MessageTable.id, {
			onDelete: "set null",
			onUpdate: "cascade",
		}),
		cwd: text("cwd").notNull(),
		name: text("name"),
		version: integer("version").notNull().default(1),
		...Timestamps,
	},
	(table) => [
		index("session_project_idx").on(table.projectId),
		index("session_parent_session_idx").on(table.parentSessionId),
		index("session_active_leaf_message_idx").on(table.activeLeafMessageId),
	],
);

export const MessageTable = sqliteTable(
	"message",
	{
		id: text().primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => SessionTable.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		parentMessageId: text("parent_message_id").references((): AnySQLiteColumn => MessageTable.id, {
			onDelete: "set null",
			onUpdate: "cascade",
		}),
		intent: text("intent").notNull().$type<Message.MessageIntent>(),
		...Timestamps,
		data: text({ mode: "json" }).notNull().$type<Message.MessageData>(),
	},
	(table) => [
		index("message_session_idx").on(table.sessionId),
		index("message_intent_idx").on(table.intent),
		index("message_parent_message_idx").on(table.parentMessageId),
		index("message_session_parent_message_idx").on(table.sessionId, table.parentMessageId),
	],
);

export const PartTable = sqliteTable(
	"part",
	{
		id: text().primaryKey(),
		messageId: text("message_id")
			.notNull()
			.references(() => MessageTable.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		sessionId: text("session_id").notNull(),
		...Timestamps,
		data: text({ mode: "json" }).notNull().$type<Message.PartData>(),
	},
	(table) => [index("part_message_idx").on(table.messageId), index("part_session_idx").on(table.sessionId)],
);
