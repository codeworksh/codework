import { iife } from "@codeworksh/utils";
import { Filesystem } from "@codeworksh/utils";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import path from "path";
import { Database, eq } from "../storage/db";
import { git } from "../util/git";
import { Log } from "../util/log";
import { ProjectTable } from "./project.sql";

export namespace Project {
	const log = Log.create({ service: "Project" });

	export const Info = Type.Object(
		{
			id: Type.String(),
			worktree: Type.String(),
			vcs: Type.Optional(Type.Union([Type.Literal("git"), Type.Literal("unknown")])),
			name: Type.Optional(Type.String()),
			icon: Type.Optional(
				Type.Object({
					url: Type.Optional(Type.String()),
					color: Type.Optional(Type.String()),
				}),
			),
			repo: Type.Optional(Type.String()),
			time: Type.Object({
				created: Type.Number(),
				updated: Type.Number(),
				initialized: Type.Optional(Type.Number()),
			}),
		},
		{ $id: "Project" },
	);
	export type Info = Static<typeof Info>;

	type Row = typeof ProjectTable.$inferSelect;
	type RowInsert = typeof ProjectTable.$inferInsert;

	export function fromRow(row: Row): Info {
		const icon =
			row.iconUrl || row.iconColor
				? { url: row.iconUrl ?? undefined, color: row.iconColor ?? undefined }
				: undefined;
		return {
			id: row.id,
			worktree: row.worktree,
			vcs: row.vcs ? Value.Cast(Project.Info.properties.vcs, row.vcs) : undefined,
			name: row.name ?? undefined,
			repo: row.repo ?? undefined,
			icon,
			time: {
				created: row.createdAt,
				updated: row.updatedAt,
				initialized: row.initializedAt ?? undefined,
			},
		};
	}

	export async function fromDirectory(directory: string) {
		log.info("fromDirectory", { directory });

		// Use git as the source of truth for repository detection.
		// Filesystem .git sniffing is intentionally avoided — git validates the repo internally.
		const data: Info = await iife(async () => {
			const global: Info = {
				id: "global",
				worktree: "/",
				vcs: "unknown" as const,
				time: { created: Date.now(), updated: Date.now() },
			};

			const gitBinary = Bun.which("git");
			if (!gitBinary) return global;

			// Let git confirm this is a real repo and give us the canonical root.
			// Fails with non-zero exit for non-git dirs (fake .git won't fool this).
			const top = await git(["rev-parse", "--show-toplevel"], {
				cwd: directory,
			})
				.then((result) => result.text().trim() || undefined)
				.catch(() => undefined);

			if (!top) return global;

			const name = path.basename(top);

			// Common git dir: same as .git for main repos, points to main .git for worktrees.
			// Used as the canonical location for the codework ID cache.
			const commonGitDir = await git(["rev-parse", "--git-common-dir"], {
				cwd: top,
			})
				.then((result) => {
					const common = result.text().trim();
					if (!common) return null;
					return path.isAbsolute(common) ? common : path.resolve(top, common);
				})
				.catch(() => null);

			// Worktree = parent of the common git dir (the main repo root).
			const worktree = commonGitDir ? (commonGitDir === top ? top : path.dirname(commonGitDir)) : top;

			// Read cached project ID from the common git dir.
			let id = commonGitDir
				? await Filesystem.readText(path.join(commonGitDir, "codework"))
						.then((x) => x.trim())
						.catch(() => undefined)
				: undefined;

			if (!id) {
				const roots = await git(["rev-list", "--max-parents=0", "--all"], {
					cwd: top,
				})
					.then((result) =>
						result
							.text()
							.split("\n")
							.filter(Boolean)
							.map((x) => x.trim())
							.toSorted(),
					)
					.catch(() => undefined);

				// No commits yet (empty repo) — can't derive a stable ID
				if (!roots?.length) {
					return { ...global, worktree, name, vcs: "git" as const };
				}

				id = roots[0];
				if (id && commonGitDir) {
					await Filesystem.write(path.join(commonGitDir, "codework"), id).catch(() => undefined);
				}
			}

			const gitRemote = await git(["remote", "get-url", "origin"], { cwd: top })
				.then((result) => result.text().trim() || undefined)
				.catch(() => undefined);

			return {
				id: id ?? "global",
				worktree,
				name,
				vcs: "git" as const,
				repo: gitRemote,
				time: { created: Date.now(), updated: Date.now() },
			};
		});

		const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, data.id)).get());
		const existing = row ? fromRow(row) : null;

		if (!existing && data.id !== "global") {
			await migrateFromGlobal(data.id, data.worktree);
		}

		const now = Date.now();
		const result: Info = {
			id: data.id,
			worktree: data.worktree,
			// Prefer user-set name; fall back to directory-derived name
			name: existing?.name ?? data.name,
			icon: existing?.icon,
			repo: data.repo,
			vcs: data.vcs as Info["vcs"],
			time: {
				created: existing?.time.created ?? now,
				updated: now,
				initialized: existing?.time.initialized ?? data.time.initialized,
			},
		};
		const insert: RowInsert = {
			id: result.id,
			worktree: result.worktree,
			vcs: result.vcs ?? null,
			name: result.name ?? null,
			repo: result.repo ?? null,
			iconUrl: result.icon?.url ?? null,
			iconColor: result.icon?.color ?? null,
			initializedAt: result.time.initialized ?? null,
			createdAt: result.time.created,
			updatedAt: result.time.updated,
		};
		// Only update fields derived from directory detection.
		// User-editable fields (name, icon) and createdAt are intentionally excluded.
		const updateSet = {
			worktree: result.worktree,
			vcs: result.vcs ?? null,
			repo: result.repo ?? null,
			updatedAt: result.time.updated,
		};
		Database.use((db) =>
			db.insert(ProjectTable).values(insert).onConflictDoUpdate({ target: ProjectTable.id, set: updateSet }).run(),
		);
		return { project: result, worktree: result.worktree };
	}

	async function migrateFromGlobal(id: string, worktree: string) {
		const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, "global")).get());
		if (!row) return;
		// @sanchitrk: TODO: add support, once we have child nodes
		log.info("TODO: migrate project global", { id, worktree });
	}

	export function setInitialized(id: string) {
		Database.use((db) =>
			db
				.update(ProjectTable)
				.set({
					initializedAt: Date.now(),
				})
				.where(eq(ProjectTable.id, id))
				.run(),
		);
	}
}
