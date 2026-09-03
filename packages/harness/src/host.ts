import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";

/** Node-backed filesystem for Harness-owned files outside sandbox namespaces. */
export const fileSystem = Effect.runSync(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)));

/** Platform-native paths for Harness-owned files outside sandbox namespaces. */
export const hostPath = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
