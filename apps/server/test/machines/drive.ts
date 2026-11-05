/* @effect-diagnostics nodeBuiltinImport:off -- run inside a machine to drive its own server over loopback. */
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { readFileSync } from "node:fs";
import { Client } from "../../../../packages/codework/src/server/client.ts";

/*
 * `node --conditions=development drive.ts < calls.json`: runs `[[method, payload], ...]` in order
 * against the CodeWork server on this machine's loopback, and prints their results as one JSON
 * array. A cut network (net.sh) blocks eth0 only, so the machine can still change its own store.
 */

type Call = readonly [method: string, payload: unknown];
type Method = (payload: unknown) => Effect.Effect<unknown, unknown>;

const calls = JSON.parse(readFileSync(0, "utf8")) as ReadonlyArray<Call>;

NodeRuntime.runMain(
	Effect.gen(function* () {
		// The calls come from the suite by name, so the typed client is indexed as a table.
		const rpc = (yield* Client.make) as unknown as Record<string, Method>;
		const results: Array<unknown> = [];
		for (const [method, payload] of calls) results.push(yield* rpc[method]!(payload));
		yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(results)}\n`));
	}).pipe(Effect.scoped, Effect.provide(Client.layer("ws://127.0.0.1:7433/rpc/v1"))),
);
