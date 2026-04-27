import { Log } from "../util/log.ts";
import { Type, type Static } from "@sinclair/typebox";
import { fn } from "@codeworksh/utils";
import { v7 as uuidv7 } from "uuid";
import { Slug } from "../util/slug.ts";
import { Config } from "../config/config.ts";
import { Instance } from "../project/instance.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { SessionTable, type InsertSession } from "./session.sql.ts";
import { Database } from "../storage/db.ts";

export namespace Session {
	const log = Log.create({ service: "session" });

	const parentNamePrefix = "New - ";
	const childNamePrefix = "Fork - ";
	const durableEvents: Event[] = [];
	const durableSubscribers = new Set<ReadableStreamDefaultController<Event>>();

	function createDefaultName(isChild = false) {
		return (isChild ? childNamePrefix : parentNamePrefix) + new Date().toISOString();
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

	export const Info = Type.Object({
		id: Type.String(),
		slug: Type.String(),
		projectId: Type.String(),
		workspaceId: Type.Optional(Type.String()),
		parentSessionId: Type.Optional(Type.String()),
		activeLeafMessageId: Type.Optional(Type.String()),
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

	export const Event = Type.Object({
		id: Type.String(),
		type: Type.Literal("session.created"),
		time: Type.Number(),
		session: Info,
	});
	export type Event = Static<typeof Event>;

	export function durableStream(input?: { after?: string }) {
		const afterIndex = input?.after ? durableEvents.findIndex((event) => event.id === input.after) : -1;
		const replay = afterIndex === -1 ? durableEvents : durableEvents.slice(afterIndex + 1);
		let subscriber: ReadableStreamDefaultController<Event>;

		return new ReadableStream<Event>({
			start(controller) {
				subscriber = controller;
				for (const event of replay) controller.enqueue(event);
				durableSubscribers.add(controller);
			},
			cancel() {
				durableSubscribers.delete(subscriber);
			},
		});
	}

	function publish(event: Event) {
		durableEvents.push(event);
		for (const subscriber of durableSubscribers) {
			try {
				subscriber.enqueue(event);
			} catch {
				durableSubscribers.delete(subscriber);
			}
		}
	}

	export const create = fn(
		Type.Optional(
			Type.Object({
				parentSessionId: Type.Optional(Type.String()),
				name: Type.Optional(Type.String()),
			}),
		),
		async (input) => {
			return createNext({
				directory: Instance.directory,
				parentSessionId: input?.parentSessionId,
				name: input?.name,
			});
		},
	);

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
			parentSessionId: input.parentSessionId,
			workspaceId: WorkspaceContext.workspaceId,
			name: input.name ?? createDefaultName(!!input.name),
			time: {
				created: Date.now(),
				updated: Date.now(),
			},
		};
		log.info("created", result);
		await Database.use(async (db) => {
			await db.insert(SessionTable).values(toRow(result)).run();
			Database.effect(() =>
				publish({
					id: uuidv7(),
					type: "session.created",
					time: Date.now(),
					session: result,
				}),
			);
		});
		return result;
	}
}
