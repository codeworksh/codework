import "./utils/env.ts";
import { Effect, type Layer, type Scope } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { LLM } from "../src/runner/llm.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { immediateOpen } from "./fixtures/llm.ts";

/**
 * A session's settings come from the host directory the session was given, and from nothing else.
 *
 * Every assertion here reads `thinkingLevel` off the request the loop built, because that is the
 * observable end of "which settings file was read". Each project writes a different one, so the
 * value names the layer.
 */

/** `home` holds the user layer; each project is a directory with its own `.codework/`. */
const withProjects = async (
	test: (dirs: Record<"root" | "home" | "alpha" | "beta" | "outer", string>) => Promise<void>,
) => {
	const root = await mkdtemp(join(tmpdir(), "codework-hostdir-"));
	// `outer` is a project that *contains* the others, so a walk that starts anywhere below it
	// finds something. That is what makes "no project layer" a real assertion rather than a
	// coincidence of an empty temp directory.
	const outer = join(root, "outer");
	const dirs = {
		root,
		home: join(root, "home"),
		alpha: join(outer, "alpha"),
		beta: join(outer, "beta"),
		outer,
	};
	try {
		for (const [name, dir] of Object.entries(dirs)) {
			if (name === "root") continue;
			await mkdir(join(dir, ".codework"), { recursive: true });
		}
		await Promise.all([
			// The user layer. `home` is `--home`, so its settings file sits at the top level.
			// Every level written here is one the built-in default ("high") is not, so an
			// assertion names the file that was read rather than agreeing with the fallback.
			writeFile(join(dirs.home, "settings.jsonc"), JSON.stringify({ model: { thinkingLevel: "off" } })),
			level(dirs.alpha, "low"),
			level(dirs.beta, "medium"),
			level(dirs.outer, "max"),
		]);
		await test(dirs);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};

const level = (project: string, thinkingLevel: string) =>
	writeFile(join(project, ".codework", "settings.jsonc"), JSON.stringify({ model: { thinkingLevel } }));

type Harnessed = Layer.Success<ReturnType<typeof Harness.layer>>;

const run = <A, E>(
	dirs: Record<"root" | "home" | "alpha" | "beta" | "outer", string>,
	body: Effect.Effect<A, E, Harnessed | Scope.Scope>,
	options: { readonly hostCwd?: string; readonly database?: string } = {},
) =>
	Effect.runPromise(
		body.pipe(
			Effect.provide(
				Harness.layer({
					home: dirs.home,
					// The process starts inside a project, so a fallback to it would be invisible:
					// a session with no host directory would read `alpha` and look correct.
					hostCwd: options.hostCwd ?? dirs.alpha,
					database: options.database ?? ":memory:",
					llm: open(),
					plugins: [defaultPromptPlugin],
				}),
			),
			Effect.scoped,
			Effect.timeout("20 seconds"),
			Effect.orDie,
		),
	);

let inputs: LLM.Input[] = [];
const open = (): LLM.Open => {
	const inner = immediateOpen();
	return (input, signal) => {
		inputs.push(input);
		return inner(input, signal);
	};
};
const lastLevel = () => inputs.at(-1)?.thinkingLevel;

describe("a session's host directory decides its settings", () => {
	it("gives two sessions in one process the project each was placed in", () =>
		withProjects(async (dirs) => {
			inputs = [];
			await run(
				dirs,
				Effect.gen(function* () {
					const first = yield* Session.create({ hostDir: dirs.alpha });
					yield* first.run("one");
					expect(lastLevel()).toBe("low");

					const second = yield* Session.create({ hostDir: dirs.beta });
					yield* second.run("two");
					expect(lastLevel()).toBe("medium");

					// And the first has not been disturbed by the second: each exchange discovers
					// from its own session, not from whichever ran most recently.
					yield* first.run("three");
					expect(lastLevel()).toBe("low");
				}),
			);
		}));

	it("reads the user layer only when the session was given no host directory", () =>
		withProjects(async (dirs) => {
			inputs = [];
			await run(
				dirs,
				Effect.gen(function* () {
					const session = yield* Session.create({});
					yield* session.run("one");
					// Not "low" (the process's own directory) and not "max" (its parent project).
					// Absent skips the walk; it does not pick a plausible starting point.
					expect(lastLevel()).toBe("off");
					expect((yield* session.info).hostDir).toBeUndefined();
				}),
			);
		}));

	it("does not discover from the session's own directory, even when that path exists on the host (T7)", () =>
		withProjects(async (dirs) => {
			inputs = [];
			await run(
				dirs,
				Effect.gen(function* () {
					// `directory` names a place inside the session's space. Here it collides with a
					// real host project — the case that makes the bug silent, because the walk
					// succeeds and returns a stranger's settings.
					const session = yield* Session.create({ directory: dirs.beta });
					yield* session.run("one");
					expect(lastLevel()).toBe("off");
				}),
			);
		}));

	it("takes a host directory on a session that already has none, from the next exchange", () =>
		withProjects(async (dirs) => {
			inputs = [];
			await run(
				dirs,
				Effect.gen(function* () {
					const session = yield* Session.create({});
					yield* session.run("one");
					expect(lastLevel()).toBe("off");

					yield* Session.link({ sessionId: session.id, hostDir: dirs.beta });
					yield* session.run("two");
					expect(lastLevel()).toBe("medium");
					expect((yield* session.info).hostDir).toBe(dirs.beta);

					// And back off again: clearing returns the session to the user layer.
					yield* Session.link({ sessionId: session.id, hostDir: null });
					yield* session.run("three");
					expect(lastLevel()).toBe("off");
				}),
			);
		}));

	it("keeps the host directory across processes", () =>
		withProjects(async (dirs) => {
			inputs = [];
			const database = join(dirs.root, "sessions.db");
			let sessionId = "";
			await run(
				dirs,
				Effect.gen(function* () {
					const session = yield* Session.create({ hostDir: dirs.beta });
					sessionId = session.id;
				}),
				{ database },
			);
			// A second harness over the same file: nothing is carried over in memory, so the
			// project a resumed session reads has to have come off the row.
			await run(
				dirs,
				Effect.gen(function* () {
					const session = yield* Session.attach({ sessionId: Session.SessionSchema.ID.make(sessionId) });
					expect((yield* session.info).hostDir).toBe(dirs.beta);
					yield* session.run("one");
					expect(lastLevel()).toBe("medium");
				}),
				{ database },
			);
		}));
});
