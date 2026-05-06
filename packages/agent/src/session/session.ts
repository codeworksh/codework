import { Log } from "../util/log";
import Type, { type Static } from "typebox";
import { fn } from "@codeworksh/utils";
import { v7 as uuidv7 } from "uuid";
import { Slug } from "../util/slug";
import { Config } from "../config/config";
import { Instance } from "../project/instance";
import { WorkspaceContext } from "../workspace/context";
import { SessionTable, type InsertSession, type SelectSession } from "./session.sql";
import { Database, eq, isNull, gte, like, and, desc, NotFoundError } from "../storage/db";

export namespace Session {
	const log = Log.create({ service: "session" });

	const parentNamePrefix = "New - ";
	const childNamePrefix = "Child - ";

	function createDefaultName(isChild = false, time = Date.now()) {
		return (isChild ? childNamePrefix : parentNamePrefix) + new Date(time).toISOString();
	}

	export function toRow(info: Info): InsertSession {
		return {
			id: info.id,
			projectId: info.projectId,
			workspaceId: info.workspaceId,
			parentSessionId: info.parentSessionId,
			slug: info.slug,
			directory: info.directory,
			name: info.name,
			version: info.version,
			createdAt: info.time.created,
			updatedAt: info.time.updated,
			timeCompacting: info.time.compacting,
			timeArchived: info.time.archived,
		};
	}

	export function fromRow(row: SelectSession): Info {
		return {
			id: row.id,
			slug: row.slug,
			projectId: row.projectId,
			workspaceId: row.workspaceId ?? undefined,
			parentSessionId: row.parentSessionId ?? undefined,
			name: row.name ?? createDefaultName(!!row.parentSessionId, row.createdAt),
			directory: row.directory,
			time: {
				created: row.createdAt,
				updated: row.updatedAt,
				compacting: row.timeCompacting ?? undefined,
				archived: row.timeArchived ?? undefined,
			},
			version: row.version,
		};
	}

	export const Info = Type.Object({
		id: Type.String(),
		slug: Type.String(),
		projectId: Type.String(),
		workspaceId: Type.Optional(Type.String()),
		parentSessionId: Type.Optional(Type.String()),
		name: Type.String(),
		directory: Type.String(),
		time: Type.Object({
			created: Type.Number(),
			updated: Type.Number(),
			compacting: Type.Optional(Type.Number()),
			archived: Type.Optional(Type.Number()),
		}),
		version: Type.String(),
	});

	export type Info = Static<typeof Info>;

	export const create = fn(
		Type.Optional(
			Type.Object({
				parentSessionId: Type.Optional(Type.String()),
				name: Type.Optional(Type.String()),
			}),
		),
		async (input) => {
			const data = input ?? {};
			return createNext({
				parentSessionId: data.parentSessionId,
				name: data.name,
				directory: Instance.directory,
			});
		},
	);

	export async function* list(input: {
		directory?: string;
		workspaceId?: string;
		roots?: boolean;
		start?: number;
		search?: string;
		limit?: number;
	}) {
		const project = Instance.project;
		const conditions = [eq(SessionTable.projectId, project.id)];
		const workspaceId = input?.workspaceId ?? WorkspaceContext.workspaceId;
		if (workspaceId) {
			conditions.push(eq(SessionTable.workspaceId, workspaceId));
		}
		if (input?.directory) {
			conditions.push(eq(SessionTable.directory, input.directory));
		}
		if (input?.roots) {
			conditions.push(isNull(SessionTable.parentSessionId));
		}
		if (input?.start) {
			conditions.push(gte(SessionTable.updatedAt, input.start));
		}
		if (input?.search) {
			conditions.push(like(SessionTable.name, `%${input.search}%`));
		}

		const limit = input?.limit ?? 100;
		const rows = await Database.use((db) =>
			db
				.select()
				.from(SessionTable)
				.where(and(...conditions))
				.orderBy(desc(SessionTable.updatedAt))
				.limit(limit)
				.all(),
		);
		for (const row of rows) {
			yield fromRow(row);
		}
	}

	export const get = fn(Type.String(), async (id) => {
		const row = await Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get());
		if (!row) throw new NotFoundError({ message: `session not found: ${id}` });
		return fromRow(row);
	});

	export async function createNext(input: {
		id?: string;
		name?: string;
		parentSessionId?: string;
		directory: string;
	}) {
		const result: Info = {
			id: input.id ?? uuidv7(),
			slug: Slug.create(),
			version: (await Config.global()).pkgVersion,
			projectId: Instance.project.id,
			directory: input.directory,
			workspaceId: WorkspaceContext.workspaceId,
			parentSessionId: input.parentSessionId,
			name: input.name ?? createDefaultName(!!input.parentSessionId),
			time: {
				created: Date.now(),
				updated: Date.now(),
			},
		};
		log.info("created", result);
		await Database.use(async (db) => {
			await db.insert(SessionTable).values(toRow(result)).run();
			// TODO implement durable stream
			Database.effect(() => {});
		});
		return result;
	}

	export const setName = fn(
		Type.Object({
			sessionId: Type.String(),
			name: Type.String(),
		}),
		async (input) => {
			return await Database.use(async (db) => {
				const row = await db
					.update(SessionTable)
					.set({ name: input.name })
					.where(eq(SessionTable.id, input.sessionId))
					.returning()
					.get();
				if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionId}` });
				const info = fromRow(row);
				Database.effect(() => {});
				return info;
			});
		},
	);

	export const setArchived = fn(
		Type.Object({
			sessionId: Type.String(),
			time: Type.Optional(Type.Number()),
		}),
		async (input) => {
			return await Database.use(async (db) => {
				const row = await db
					.update(SessionTable)
					.set({ timeArchived: input.time })
					.where(eq(SessionTable.id, input.sessionId))
					.returning()
					.get();
				if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionId}` });
				const info = fromRow(row);
				Database.effect(() => {});
				return info;
			});
		},
	);
}
