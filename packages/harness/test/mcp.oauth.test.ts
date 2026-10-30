import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber, Schedule } from "effect";
import { expect } from "vite-plus/test";
import { McpClient } from "../src/mcp/client.ts";
import { McpOAuth } from "../src/mcp/oauth.ts";
import { Process } from "../src/sandbox/utils/process.ts";
import { listen } from "./fixtures/mcp/http.ts";
import { oauth } from "./fixtures/oauth.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { testEffect } from "./utils/effect.ts";

const { live: it } = testEffect(Process.host);

type Stored = Record<string, McpOAuth.State | undefined>;

/** A home whose credential file holds tokens the fixture issued, and a connection using them. */
const setup = Effect.fn(function* () {
	const dir = yield* Effect.acquireRelease(
		Effect.promise(() => tmpdir()),
		(dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
	);
	const fixture = oauth();
	const url = yield* listen(fixture.handler);
	const server: McpOAuth.Server = { name: "secure", url: url.href };
	const store = McpOAuth.store(dir.path);
	const id = McpOAuth.key(server);
	const tokens = fixture.issue();
	yield* store.update(server.name, id, () => ({
		clientInformation: { client_id: "client-1", redirect_uris: ["http://127.0.0.1/callback"] },
		tokens,
		tokensExpireAt: Date.now() + 3_600_000,
	}));
	const connection = yield* McpClient.connect({
		server: server.name,
		endpoint: { _tag: "Http", url, headers: {} },
		authProvider: yield* McpOAuth.connection({ store, server }),
	});
	const stored = () => {
		const file = join(dir.path, "mcpauth.json");
		const entry = (JSON.parse(readFileSync(file, "utf8")) as Stored)[id];
		return {
			access: entry?.tokens?.access_token,
			refresh: entry?.tokens?.refresh_token,
			mode: (statSync(file).mode & 0o777).toString(8),
		};
	};
	const expire = store.update(server.name, id, (state) => ({ ...state, tokensExpireAt: Date.now() }));
	return { fixture, store, connection, stored, expire };
});

const text = (result: { readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> }) =>
	(result.content ?? []).map((part) => part.text ?? "").join("");

/**
 * Interrupts a `whoami` call once its refresh reaches the token endpoint, then lets the token
 * endpoint answer. Returns what the server saw meanwhile and the next call's answer.
 */
const interruptDuringRefresh = Effect.fn(function* (input: Effect.Success<ReturnType<typeof setup>>) {
	const { fixture, store, connection, stored } = input;
	const reached = yield* Deferred.make<void>();
	const release = yield* Deferred.make<void>();
	fixture.state.beforeToken = () => {
		Deferred.doneUnsafe(reached, Effect.void);
		return Effect.runPromise(Deferred.await(release));
	};
	const call = yield* connection.callTool({ name: "whoami" }).pipe(Effect.forkChild);
	yield* Deferred.await(reached).pipe(Effect.timeout("5 seconds"));
	const exit = yield* Fiber.await(yield* Fiber.interrupt(call).pipe(Effect.as(call)));
	fixture.state.beforeToken = undefined;
	yield* Deferred.succeed(release, undefined);
	yield* Effect.sync(() => store.refreshing.size).pipe(
		Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: (size) => size === 0 }),
		Effect.timeout("5 seconds"),
	);
	// Long enough for a request retried after the refresh to reach the server.
	yield* Effect.sleep("500 millis");
	const afterInterrupt = [...fixture.state.log];
	const storedAfter = stored();
	const next = text(yield* connection.callTool({ name: "whoami" }));
	return { interrupted: Exit.hasInterrupts(exit), afterInterrupt, stored: storedAfter, next, log: fixture.state.log };
});

const calls = (log: ReadonlyArray<Record<string, unknown>>) =>
	log.filter((entry) => entry.mcp === "tools/call" && entry.refused === undefined);

it(
	"mcp oauth: a call interrupted while its refresh is pending is never sent, and the refresh is kept",
	Effect.gen(function* () {
		// Rejected after connecting: the call gets a 401 and waits for the refresh it starts.
		const rejected = yield* setup();
		rejected.fixture.state.access.clear();
		const afterUnauthorized = yield* interruptDuringRefresh(rejected);

		// About to expire after connecting: the refresh runs before the call is sent.
		const expiring = yield* setup();
		yield* expiring.expire;
		const beforeSend = yield* interruptDuringRefresh(expiring);

		for (const outcome of [afterUnauthorized, beforeSend]) {
			expect(outcome.interrupted).toBe(true);
			// The interrupted call never reached the server, before or after the refresh.
			expect(calls(outcome.afterInterrupt)).toEqual([]);
			// The refresh the server answered is saved whole: its rotated refresh token is the one stored.
			expect(outcome.stored).toEqual({ access: "access-2", refresh: "refresh-2", mode: "600" });
			expect(outcome.next).toBe("called with access-2");
			expect(calls(outcome.log)).toEqual([{ mcp: "tools/call", token: "access-2" }]);
		}

		yield* Effect.promise(() =>
			expect(`${JSON.stringify({ afterUnauthorized, beforeSend }, null, "\t")}\n`).toMatchFileSnapshot(
				"./__artifacts__/mcp.oauth.interrupt.json",
			),
		);
	}),
	30_000,
);
