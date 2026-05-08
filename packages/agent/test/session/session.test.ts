import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Session as SessionNamespace } from "../../src/session/session";
import { StreamStore } from "@durable-streams/server";
import { afterEach, describe, expect, it } from "vite-plus/test";

process.env.CODEWORK_HOME_DIR = path.join(os.tmpdir(), "codework-agent-session-test");

const { Bus } = await import("../../src/streaming/bus");
const { GlobalBus } = await import("../../src/streaming/global");
const { Database } = await import("../../src/storage/db");
const { Instance } = await import("../../src/project/instance");
const { createLocalNodeEnv } = await import("../../src/sandbox/builtin");
const { Session } = await import("../../src/session/session");
const { WorkspaceContext } = await import("../../src/workspace/context");

const tempDirectories = new Set<string>();

async function readEvents<T>(store: StreamStore) {
	const reader = await GlobalBus.reader({ store, topic: "events" });
	const response = await reader.client.stream<T>({
		offset: "-1",
		live: false,
		json: true,
	});
	return response.json<T>();
}

async function waitForEvents<T>(store: StreamStore, count: number) {
	for (let attempt = 0; attempt < 20; attempt++) {
		const events = await readEvents<T>(store);
		if (events.length >= count) return events;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${count} durable event(s)`);
}

async function createTempDirectory(name: string) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), `codework-${name}-`));
	tempDirectories.add(directory);
	return directory;
}

afterEach(async () => {
	await Instance.disposeAll();
	await GlobalBus.disposeAll();
	Database.close();
	await Promise.all(
		[...tempDirectories].map(async (directory) => {
			await fs.rm(directory, { force: true, recursive: true });
			tempDirectories.delete(directory);
		}),
	);
});

describe("Session events", () => {
	it("emits session.created when a session is created", async () => {
		const directory = await createTempDirectory("session-event");
		const sandbox = await createLocalNodeEnv(directory);
		const store = new StreamStore();

		await WorkspaceContext.provide({
			workspaceId: "session-event-workspace",
			sandbox,
			fn: async () => {
				await Instance.provide({
					id: sandbox.id,
					directory: sandbox.cwd,
					fn: async () => {
						const global = await GlobalBus.create({
							stream: true,
							store,
							producerId: "global",
							topic: "events",
						});
						const bus = await Bus.create({ global });
						const received: SessionNamespace.Info[] = [];

						const unsubscribe = bus.subscribe(Session.Event.Created, (event) => {
							received.push(event.properties.info);
						});

						const first = await Session.create({ name: "First" });
						const second = await Session.create({ name: "Second" });
						unsubscribe();

						expect(received.map((info) => info.id)).toEqual([first.id, second.id]);
						expect(received[0]?.projectId).toBe(first.projectId);
						expect(received[0]?.workspaceId).toBe("session-event-workspace");
						expect(received[0]?.directory).toBe(first.directory);
						expect(received[0]?.name).toBe(first.name);

						const durableEvents = await waitForEvents<{
							type: string;
							properties: {
								info: SessionNamespace.Info;
							};
						}>(store, 2);
						const created = durableEvents.filter((event) => event.type === Session.Event.Created.type);

						expect(created.map((event) => event.properties.info.id)).toEqual([first.id, second.id]);
					},
				});
			},
		});
	});
});
