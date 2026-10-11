import { Context, Layer } from "effect";
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
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/cli/server/identity/Service") {}

/** This process: a server answers with it, a client compares a server's version against it. */
export const current: Interface = { pid: process.pid, version: pkg.version };

export const layer = Layer.succeed(Service, Service.of(current));

export * as Identity from "./identity.ts";
