import path from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "../filesystem/filesystem";
import { Git } from "../git";
import { AbsolutePath, withStatics } from "../schema";
import { Hash } from "../util/hash";

export const ID = Schema.String.pipe(
  Schema.brand("Project.ID"),
  withStatics((schema) => ({
    local: schema.make("local"),
  })),
);
export type ID = typeof ID.Type;

export const Vcs = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("git"),
    store: AbsolutePath,
  }),
]);
export type Vcs = typeof Vcs.Type;

export class Info extends Schema.Class<Info>("Project.Info")({
  id: ID,
}) {}

export const DirectoriesInput = Schema.Struct({
  projectID: ID,
}).annotate({ identifier: "Project.DirectoriesInput" });
export type DirectoriesInput = typeof DirectoriesInput.Type;

export const Directories = Schema.Array(AbsolutePath).annotate({
  identifier: "Project.Directories",
});
export type Directories = typeof Directories.Type;

export interface Interface {
  // readonly directories: (input: DirectoriesInput) => Effect.Effect<Directories>;
  readonly resolve: (input: AbsolutePath) => Effect.Effect<
    {
      previous?: ID; // previous ID before moving
      id: ID; // current ID
      directory: AbsolutePath;
      vcs?: Vcs;
      name: string;
    },
    never
  >;
}

export class Service extends Context.Service<Service, Interface>()(
  "@codework/project",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.Service;
    const git = yield* Git.Service;

    const cached = Effect.fnUntraced(function* (dir: string) {
      return yield* fs.readFileString(path.join(dir, "codework")).pipe(
        Effect.map((value) => value.trim()),
        Effect.map((value) => (value ? ID.make(value) : undefined)),
        Effect.catch(() => Effect.void),
      );
    });

    const remote = Effect.fnUntraced(function* (repo: Git.Repo) {
      const origin = yield* git.remote(repo);
      if (!origin) return undefined;
      const normalized = url(origin);
      if (!normalized) return undefined;
      return {
        id: ID.make(Hash.fast(`git:${normalized}`)),
        name: path.posix.basename(normalized),
      };
    });

    function url(input: string) {
      const value = input.trim();
      if (!value) return undefined;

      try {
        const parsed = new URL(value);
        if (parsed.protocol === "file:") return undefined;
        return parts(parsed.hostname, parsed.pathname);
      } catch {
        const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/);
        if (scp) return parts(scp[2]!, scp[3]!);
        return undefined;
      }
    }

    function parts(host: string, name: string) {
      const pathname = name
        .replace(/^\/+/, "")
        .replace(/\.git\/?$/, "")
        .replace(/\/+$/, "");
      if (!host || !pathname) return undefined;
      return `${host.toLowerCase()}/${pathname}`;
    }

    const root = Effect.fnUntraced(function* (repo: Git.Repo) {
      const root = (yield* git.roots(repo))[0];
      return root ? ID.make(root) : undefined;
    });

    const resolve = Effect.fn("Project.resolve")(function* (
      input: AbsolutePath,
    ) {
      const repo = yield* git.find(input);
      if (!repo) {
        return {
          id: ID.local,
          directory: input,
          name: path.basename(path.normalize(input)),
        };
      }

      const previous = yield* cached(repo.store);
      const origin = yield* remote(repo);
      const id = origin?.id ?? previous ?? (yield* root(repo));
      return {
        id: id ?? ID.local,
        ...(previous ? { previous } : {}),
        directory: repo.directory,
        vcs: { type: "git" as const, store: repo.store },
        name: origin?.name ?? path.basename(path.normalize(repo.directory)),
      };
    });

    return Service.of({ resolve });
  }),
);
