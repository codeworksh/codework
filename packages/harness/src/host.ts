import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";

/** Node-backed filesystem for Harness-owned files outside sandbox namespaces. */
export const fileSystem = Effect.runSync(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)));
