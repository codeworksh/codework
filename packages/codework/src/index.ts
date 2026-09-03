#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import type { CliError } from "effect/unstable/cli";
import pkg from "../package.json" with { type: "json" };
import { Cmd } from "./cli/cmd/cmd.ts";
import type { CommandError } from "./cli/error.ts";
import { Runtime } from "./framework/runtime.ts";

const Handlers = Runtime.handlers(Cmd, {
	run: () => import("./cli/cmd/handlers/run.ts"),
	modelgen: () => import("./cli/cmd/handlers/modelgen.ts"),
});

export const main: Effect.Effect<void, CommandError | CliError.CliError> = Runtime.run(Cmd, Handlers, {
	version: pkg.version,
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(main);
