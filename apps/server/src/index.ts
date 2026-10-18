import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { Server } from "./server.ts";

// A shutdown that hangs would leave this process running with nobody left to stop it, so once asked to
// stop it ends within this long whatever is still winding down.
const SHUTDOWN_GRACE_MS = 5000;
for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.once(signal, () => setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref());

NodeRuntime.runMain(Layer.launch(Server.layer));
