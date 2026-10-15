import type { Message, Session } from "./contract.ts";

// Stand-in conversations for `sessions.get` until it reads them from the CodeWork server.

const hour = 60 * 60 * 1000;
const now = Date.now();

const conversation = (topic: string): readonly Message[] => [
	{ role: "user", text: `Can you help with ${topic}?` },
	{ role: "assistant", text: `Sure. Let me look at the code involved in ${topic} first.` },
	{ role: "user", text: "Keep the change small." },
	{ role: "assistant", text: "Done: one focused change, checks pass." },
];

const sessions: readonly Session[] = [
	{ id: "s1", project: "codework", title: "Desktop navigation", updated: now - 1 * hour },
	{ id: "s2", project: "codework", title: "Widget persistence", updated: now - 5 * hour },
	{ id: "s3", project: "codework", title: "Bus design review", updated: now - 30 * hour },
	{
		id: "s7",
		project: "codework",
		title: "Rotate the OpenRouter key sk-or-v1-20b4d7e9a1c3b8f2fce",
		updated: now - 40 * hour,
	},
	{ id: "s4", project: "webwm", title: "Grid layout gaps", updated: now - 3 * hour },
	{ id: "s5", project: "webwm", title: "Pinned slots", updated: now - 50 * hour },
	{ id: "s6", project: "notes", title: "Weekly plan", updated: now - 72 * hour },
].map((session) => ({ ...session, messages: conversation(session.title.toLowerCase()) }));

export const findSession = (id: string) => sessions.find((session) => session.id === id);
