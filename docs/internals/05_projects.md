# Projects

A project is a body of work across every place it is checked out. A space is one directory of a project in one env. A location is a space plus the exact directory a run works in. The shapes live in `packages/plugin` ([project.ts](../../packages/plugin/src/project.ts), [space.ts](../../packages/plugin/src/space.ts), [location.ts](../../packages/plugin/src/location.ts), [repo.ts](../../packages/plugin/src/repo.ts)), because every plugin context carries a resolved location. Resolving one needs the database, git and a mount, so that code lives in the harness, mostly in [project.ts](../../packages/harness/src/project/project.ts).

## Identity Is Portable, Paths Are Not

A project id never contains a path or an env. It is the first of:

1. the marker pinned in the clone,
2. a hash of the normalized `origin` remote,
3. the repository's root commit,
4. a provisional id.

The remote is normalized to a lowercase `host/path` with `.git` stripped, and the scp form is accepted ([repo.ts](../../packages/harness/src/repo/repo.ts)). An ssh clone on the host and an https clone inside a remote sandbox therefore land in one project. `file:` remotes are ignored, because they name a path.

A project's name is the one the caller passed on create, else the remote's, else the folder's. The name is set when the row is first written and never moves on conflict. Only an explicit rename changes it.

## The Marker Pins Identity

The first time a clone yields a portable id, it is written to a file named `codework` in the git store (the common git dir). Every later resolve reads the marker first. A changed remote URL or rewritten history then does not split the project.

The marker is per clone and never committed. Linked worktrees share it because they share the store. A failed write is only a warning: the next resolve computes the id again.

## Provisional Ids

A directory with no portable identity gets a provisional id: a hash of the env and the location. That covers a plain folder, and a fresh repository with no remote and no commit. The id is env-local by construction and is never written to a marker. The same folder spelled in two envs is two projects until it gains an identity.

When it does, resolve adopts what was there before:

- The space at the checkout root keeps its id and is re-pointed at the real project.
- Spaces registered in subdirectories ("strays") are absorbed into the root's space. Their sessions move with them; `session.directory` is absolute and stays put.
- A stray is adopted only when its nearest `.git` is this checkout's. A nested repository keeps its own project. A plain directory adopts nothing.
- A project left with no space is deleted. This is the only path that deletes a project row, and the `RESTRICT` foreign key leaves any project still referenced alone.

## Spaces

A space id is `hash(env, location)` with no project component ([space.ts](../../packages/harness/src/space/space.ts)). Re-pointing a space at another project, as adoption does, must never rewrite the key that sessions reference. Do not add the project to the hash.

| Kind    | Meaning                                             |
| ------- | --------------------------------------------------- |
| primary | The main checkout. At most one per project and env. |
| linked  | A git worktree sharing the primary's store.         |
| copy    | Another clone of the same project in the same env.  |
| plain   | A directory that is not a git checkout.             |

Resolving a checkout registers its whole family: `git worktree list`, filtered to what exists on disk, main checkout first. Listing never runs `git worktree prune`. A non-main member is `linked`. A main checkout claims `primary` if no other checkout holds it in this env, and becomes `copy` otherwise. A partial unique index enforces one primary per project and env, and a losing claim falls back to `copy`.

Resolution runs under one in-process lock. That is correct only because one long-running server owns the database.

## Env and the Host Column

`space.env` is a sandbox instance id. The host is `local` at runtime and `NULL` in the column. Unique indexes coalesce it to `'local'`, and every env-scoped read uses `IS`. A query written with `= ${env}` silently matches nothing for the host. See [sandboxes](./06_sandboxes.md).

## Locations

A location is the pair (space, directory). The directory is a realpath equal to or under `space.location`. That containment invariant holds everywhere a location is stored, including relink targets.

Both halves come from the mount. `Location.layer` requires `SandboxIO.Current`, so a location cannot be built outside a mount ([location.ts](../../packages/harness/src/location/location.ts)). A path is meaningful only after the mount says which tree it is in.

Every path is realpath'd before it is hashed. Two spellings of one directory produce one space.

## Moving Work

`relink` moves a session, or one thread's placement, to another space of the same project ([session.ts](../../packages/harness/src/session/session.ts)). Use it when a remote env died and the repo was cloned locally, or when a worktree is consolidated. It refuses a target that is missing or archived, a target in another project, and an explicit directory outside the target space.

Without an explicit directory, the cwd keeps its position relative to the old root, so `/old/app/pkg` lands on `/new/app/pkg`. If that path does not exist in the new space, the session lands on the resolved directory instead ([effect/session.ts](../../packages/harness/src/effect/session.ts)). The transcript is untouched.

A thread's placement is stored in its document, which no foreign key guards. A placement whose space is gone fails with `SessionLinkedSpaceNotFoundError`, and `relink --thread` is the repair.

`link` is a different operation. It changes only the session's `hostDir`, which picks the settings and plugins it reads. See [settings](./07_settings.md).

## Archiving

Spaces and projects are archived, never deleted, except for the adoption case above. A resolve brings both back to `active`.

- `Space.refresh` probes every space of a project in the current env. Only a definite "absent" archives a space. A backend that could not answer leaves the row alone.
- If the primary is gone, the oldest active `copy` is promoted. A `linked` space is never promoted, because its store died with the primary. The archived primary is demoted to `copy` first, because the unique index ignores status.
- Destroying a sandbox archives every space of that env in the same transaction as the sandbox tombstone.
- A project is archived when it has no active space in any env.

A project's host settings file belongs to its active primary or plain space on the host ([`Project.mainCheckout`](../../packages/harness/src/project/project.ts)). A project checked out only inside sandboxes has no host file to edit.
