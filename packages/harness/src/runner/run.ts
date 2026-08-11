/*
 * @file Defines API for actual run implementation (contract)
 * Typically drain wraps the run to be then drained by the coordinator.
 */

import { Context, Effect, Schema } from "effect";
import { Location } from "../location/location.ts";
import { type SandboxMountError } from "../sandbox/errors.ts";
import { SandboxFileSystem } from "../sandbox/fs/filesystem.ts";
import { SandboxInstance } from "../sandbox/instance.ts";
import { SandboxIO } from "../sandbox/io.ts";
import type { ID as SessionId } from "../session/schema.ts";

export class ShellWorkError extends Schema.TaggedError<ShellWorkError>()("Runner.ShellWorkError", {
	command: Schema.String,
	cause: Schema.Defect(),
}) {}

export class SandboxDirectoryNotFoundError extends Schema.TaggedError<SandboxDirectoryNotFoundError>()(
	"Runner.SandboxDirectoryNotFoundError",
	{
		sessionId: Schema.String,
		sandboxInstanceId: SandboxInstance.ID,
		directory: Schema.String,
	},
) {}

export type RunError =
	| ShellWorkError
	| SandboxDirectoryNotFoundError
	| SandboxMountError
	| SandboxFileSystem.FileSystemError;

export interface Interface {
	/** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
	readonly run: (input: {
		readonly sessionId: SessionId;
		readonly force: boolean;
	}) => Effect.Effect<void, RunError, SandboxIO.Provides | Location.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/runner/run/Service") {}

export * as Runner from "./run.ts";
