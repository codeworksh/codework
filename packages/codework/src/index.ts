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
	auth: () => import("./cli/cmd/handlers/auth.ts"),
	run: () => import("./cli/cmd/handlers/run.ts"),
	serve: () => import("./cli/cmd/handlers/serve.ts"),
	session: {
		link: () => import("./cli/cmd/handlers/session/link.ts"),
	},
	plugin: {
		add: () => import("./cli/cmd/handlers/plugin/add.ts"),
		check: () => import("./cli/cmd/handlers/plugin/check.ts"),
		install: () => import("./cli/cmd/handlers/plugin/install.ts"),
		list: () => import("./cli/cmd/handlers/plugin/list.ts"),
		reload: () => import("./cli/cmd/handlers/plugin/reload.ts"),
		remove: () => import("./cli/cmd/handlers/plugin/remove.ts"),
		update: () => import("./cli/cmd/handlers/plugin/update.ts"),
	},
	models: {
		$: () => import("./cli/cmd/handlers/models/list.ts"),
		providers: () => import("./cli/cmd/handlers/models/providers.ts"),
		generate: () => import("./cli/cmd/handlers/models/generate.ts"),
	},
});

export const main: Effect.Effect<void, CommandError | CliError.CliError> = Runtime.run(Cmd, Handlers, {
	version: pkg.version,
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(main);
