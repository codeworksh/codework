import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-orm/effect-schema";
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { Schema } from "effect";

export const ProjectTable = sqliteTable("project", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	vcs: text("vcs").notNull(),
});

export const ProjectDirectoryTable = sqliteTable(
	"project_directory",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => ProjectTable.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		directory: text("directory").notNull(),
		type: text("type", { enum: ["main", "root", "gitworktree"] }).notNull(),
		sandboxEnvID: text("sandbox_id").notNull(),
	},
	(table) => [uniqueIndex("project_directory_project_directory_idx").on(table.projectId, table.directory)],
);

export const ProjectSelect = createSelectSchema(ProjectTable);
export const ProjectInsert = createInsertSchema(ProjectTable);
export const ProjectUpdate = createUpdateSchema(ProjectTable);

export const ProjectDirectorySelect = createSelectSchema(ProjectDirectoryTable);
export const ProjectDirectoryInsert = createInsertSchema(ProjectDirectoryTable);
export const ProjectDirectoryUpdate = createUpdateSchema(ProjectDirectoryTable);

export const ProjectDirectory = Schema.Struct({
	id: ProjectDirectorySelect.fields.id,
	directory: ProjectDirectorySelect.fields.directory,
	type: ProjectDirectorySelect.fields.type,
	sandboxEnvID: ProjectDirectorySelect.fields.sandboxEnvID,
});

export const Project = Schema.Struct({
	...ProjectSelect.fields,
	directories: Schema.Array(ProjectDirectory),
});

export type Project = Schema.Schema.Type<typeof Project>;
export type ProjectDirectory = Schema.Schema.Type<typeof ProjectDirectory>;
