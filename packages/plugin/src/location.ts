import { Context, Schema } from "effect";
import { ProjectSchema } from "./project.ts";
import { AbsolutePath } from "./schema.ts";
import { SandboxInstance } from "./sandbox/instance.ts";
import { SpaceSchema } from "./space.ts";

/**
 * Where work happens: a directory inside a space.
 *
 * The pair (space, directory) is the key. A path alone does not name a place —
 * `/app/repo` on the host and `/app/repo` inside a remote sandbox are different
 * trees wearing the same spelling — so the space carries the env and the
 * root it lives under (`space.location`), and `directory` is the absolute cwd
 * equal to or beneath that root. Sessions sharing a space share the project;
 * worktree relationships stay a Project concern beneath it.
 *
 * **Both halves come from the mount, so `Ref` is overrides and nothing else.**
 * A Location is a directory *within* a mounted namespace — the mount has to be
 * resolved first, the way a volume is mounted before any path on it means
 * anything — and once it is, the namespace and the working directory are already
 * in scope. Re-declaring them would be two spellings of one value, free to drift;
 * a Location pointing somewhere its own shell is not becomes unrepresentable
 * rather than merely avoided by discipline.
 *
 * Only the shape and the service tag live here. Building one needs Project, Space, Repo and Git,
 * which belong to the harness; a plugin receives a resolved `Info` on its context and asks for
 * {@link Service} when it needs the live one.
 */
export const Ref = Schema.Struct({
	/** Defaults to the mount's cwd. Set it to work in a subdirectory of the mount. */
	directory: Schema.optional(AbsolutePath),
}).annotate({ identifier: "Location.Ref" });
export type Ref = typeof Ref.Type;

export class Info extends Schema.Class<Info>("Location.Info")({
	/** The absolute cwd tools run in; `space.location` is the root it lives under. */
	directory: AbsolutePath,
	space: SpaceSchema.Info,
	project: ProjectSchema.Info,
}) {}

export interface Interface extends Info {}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/plugin/location/Service") {}

const Fields = {
	directory: AbsolutePath,
	sandboxInstanceId: SandboxInstance.ID,
};

export class DirectoryNotFoundError extends Schema.TaggedError<DirectoryNotFoundError>()(
	"Location.DirectoryNotFoundError",
	Fields,
) {}

export class NotDirectoryError extends Schema.TaggedError<NotDirectoryError>()("Location.NotDirectoryError", Fields) {}

export type Error = DirectoryNotFoundError | NotDirectoryError;
