import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { Server } from "./server.ts";

NodeRuntime.runMain(Layer.launch(Server.layer));
