#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect } from "effect";

export const main: Effect.Effect<void> = Console.log("codework").pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(main);
