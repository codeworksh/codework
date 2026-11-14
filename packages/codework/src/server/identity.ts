/* @effect-diagnostics nodeBuiltinImport:off -- the host's name is the OS's hostname. */
import os from "node:os";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import pkg from "../../package.json" with { type: "json" };

/**
 * What a running server is, as its clients need to know it.
 *
 * A discovery registration names the pid and version it wrote; `server.info`
 * answers with the live ones so a caller can tell the process it reached is the
 * one that registered rather than a different server that took the same port.
 */
export interface Interface {
	readonly pid: number;
	readonly version: string;
	/** The machine it runs on, by the name its user knows it; none when the OS names it nothing. */
	readonly host?: { readonly name: string };
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/cli/server/identity/Service") {}

/** This process: a server answers with it, a client compares a server's version against it. */
export const current: Interface = { pid: process.pid, version: pkg.version };

// macOS's computer name is the one Finder and sharing show; its hostname is a mangled copy of it.
const hostName = Effect.gen(function* () {
	if (process.platform !== "darwin") return os.hostname().trim();
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const computer = yield* spawner
		.string(ChildProcess.make("scutil", ["--get", "ComputerName"]))
		.pipe(Effect.orElseSucceed(() => ""));
	return (
		computer.trim() ||
		os
			.hostname()
			.replace(/\.local$/, "")
			.trim()
	);
});

/** The host's name is read once, when the server starts. */
export const layer = Layer.effect(
	Service,
	hostName.pipe(Effect.map((name) => Service.of(name === "" ? current : { ...current, host: { name } }))),
).pipe(Layer.provide(NodeServices.layer));
