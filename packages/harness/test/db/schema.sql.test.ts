import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
	Project,
	ProjectDirectoryInsert,
	ProjectDirectorySelect,
	ProjectInsert,
	ProjectUpdate,
} from "../../src/db/schema.sql";

describe("Project schema", () => {
	it("validates a project with directories", async () => {
		const project = await Effect.runPromise(
			Schema.decodeUnknownEffect(Project)({
				id: "project-1",
				name: "codework",
				vcs: "git",
				directories: [
					{
						id: "directory-1",
						directory: "/workspace/codework",
						type: "main",
						sandboxEnvID: "sandbox-1",
					},
				],
			}),
		);

		expect(project.name).toBe("codework");
		expect(project.directories[0]?.type).toBe("main");
	});

	it("derives insert, select, and update schemas from the tables", async () => {
		const insert = await Effect.runPromise(
			Schema.decodeUnknownEffect(ProjectInsert)({
				id: "project-1",
				name: "codework",
				vcs: "git",
			}),
		);
		const update = await Effect.runPromise(Schema.decodeUnknownEffect(ProjectUpdate)({ name: "codework-next" }));
		const directory = await Effect.runPromise(
			Schema.decodeUnknownEffect(ProjectDirectoryInsert)({
				id: "directory-1",
				projectId: "project-1",
				directory: "/workspace/codework",
				type: "gitworktree",
				sandboxEnvID: "sandbox-1",
			}),
		);

		expect(insert.vcs).toBe("git");
		expect(update.name).toBe("codework-next");
		expect(directory.type).toBe("gitworktree");
		expect(ProjectDirectorySelect).toBeDefined();
	});

	it("rejects unsupported directory types", async () => {
		await expect(
			Effect.runPromise(
				Schema.decodeUnknownEffect(ProjectDirectoryInsert)({
					id: "directory-1",
					projectId: "project-1",
					directory: "/workspace/codework",
					type: "worktree",
					sandboxEnvID: "sandbox-1",
				}),
			),
		).rejects.toBeDefined();
	});
});
