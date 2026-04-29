import { type AnySQLiteColumn, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { ProjectTable } from "../project/project.sql.ts";
import { Timestamps } from "../storage/schema.sql.ts";
import type { Message } from "./message.ts";

export const SessionTable = sqliteTable(
	"session",
	{
		id: text("id").primaryKey(),
		slug: text("slug").notNull(),
		workspaceId: text("workspace_id"),
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
		directory: text("directory").notNull(),
		name: text("name"),
		version: text("version").notNull().default("0.0.0"),
		timeCompacting: integer("time_compacting"),
		timeArchived: integer("time_archived"),
		...Timestamps,
	},
	(table) => [
		index("session_project_idx").on(table.projectId),
		index("session_parent_session_idx").on(table.parentSessionId),
		index("session_active_leaf_message_idx").on(table.activeLeafMessageId),
		uniqueIndex("session_slug_idx").on(table.slug),
	],
);
export type SelectSession = InferSelectModel<typeof SessionTable>;
export type InsertSession = InferInsertModel<typeof SessionTable>;

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
