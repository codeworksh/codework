/**
 * Host folders for adding a project: browsing directories, creating and adding one, and looking
 * repositories up through the GitHub CLI. Everything here runs on the server's host.
 */
/* @effect-diagnostics nodeBuiltinImport:off -- browsing needs directory entries with their types, and the OS home. */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { expandTilde, Git } from "@codeworksh/harness/effect";
import { Context, Effect, FileSystem, Layer, Option, Path, type PlatformError, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Contract from "./contract.ts";

export interface Status {
	readonly ready: boolean;
	readonly hint?: string;
}

interface Interface {
	readonly info: { readonly home: string; readonly projects: string };
	readonly browse: (
		path: string,
	) => Effect.Effect<{ readonly path: string; readonly entries: ReadonlyArray<Contract.Folder> }, Contract.HostError>;
	readonly add: (path: string) => Effect.Effect<{ readonly path: string }, Contract.HostError>;
	readonly create: (
		name: string,
	) => Effect.Effect<{ readonly path: string; readonly commitError?: string }, Contract.HostError>;
	readonly status: () => Effect.Effect<Status>;
	readonly lookup: (repository: string) => Effect.Effect<Contract.Repository, Contract.HostError>;
	/** The `origin` URL of the checkout at `directory`, with any credentials taken out; none without one. */
	readonly remote: (directory: string) => Effect.Effect<string | undefined>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/cli/server/host/Service") {}

const MAX_NAME = 200;
const MAX_ATTEMPTS = 100;
const INSTALL_GH = "Install the GitHub CLI (gh) to clone GitHub repositories.";
const LOGIN_GH = "Run `gh auth login` to sign in to GitHub.";
const NOT_FOUND = "Repository not found. Check the owner and name and try again.";
const NOT_NAMED = "Repositories are named owner/name.";

const fail = (message: string) => new Contract.HostError({ message });

const describe = (error: PlatformError.PlatformError, target: string) =>
	error.reason._tag === "NotFound"
		? `${target} does not exist.`
		: error.reason._tag === "PermissionDenied"
			? `Permission denied: ${target}`
			: error.message;

/** The folder `host.create` claims for a project name: a slug that is never empty or a reserved Windows name. */
const folderName = (name: string) => {
	const slug = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 64)
		.replace(/-+$/, "");
	if (slug.length === 0) return "project";
	return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug) ? `${slug}-project` : slug;
};

const commitFailure = (stderr: string) => {
	if (
		/identity unknown|tell me who you are|no (name|email) was given|unable to auto-detect email|empty ident/i.test(
			stderr,
		)
	) {
		return "Git has no name or email set, so the first commit was skipped.";
	}
	const line = stderr
		.split("\n")
		.map((text) => text.trim())
		.filter(Boolean)
		.at(-1);
	return `The first commit was skipped: ${line ?? "git could not make it."}`;
};

export interface Selector {
	readonly host: string;
	/** Absent for a bare name: the signed-in user's. */
	readonly owner?: string;
	readonly name: string;
}

// Owner and name land in an API path, so anything outside GitHub's own alphabet is refused.
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const isGitHubHost = (host: string) => host === "github.com" || host.includes("github");

/** `owner/name`, `host/owner/name`, an http(s) URL, or a bare `name`; undefined for anything else. */
const parseRepository = (selector: string): Selector | undefined => {
	// Like gh, a clone URL's `.git` comes off the path, before any trailing slash.
	const segments = (value: string) =>
		value
			.replace(/\.git\/*$/i, "")
			.split("/")
			.filter(Boolean);
	const named = (host: string, owner: string | undefined, name: string | undefined): Selector | undefined =>
		name !== undefined && SEGMENT.test(name) && (owner === undefined || SEGMENT.test(owner))
			? { host, name, ...(owner === undefined ? {} : { owner }) }
			: undefined;
	const trimmed = selector.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		const url = URL.parse(trimmed);
		const parts = url === null ? [] : segments(url.pathname);
		return url !== null && parts.length === 2 ? named(url.host.toLowerCase(), parts[0], parts[1]) : undefined;
	}
	const parts = segments(trimmed);
	const [first, second, third] = parts;
	if (parts.length === 1) return named("github.com", undefined, first);
	if (parts.length === 2) return named("github.com", first, second);
	const host = first?.toLowerCase();
	return parts.length === 3 && host !== undefined && isGitHubHost(host) ? named(host, second, third) : undefined;
};

/**
 * A remote URL safe to show: an http(s) URL loses its user and password, which may be a token
 * (`https://x-access-token:...@github.com/...`). SSH and local forms carry none and pass as they are.
 */
const shownRemote = (url: string) => {
	if (!/^https?:\/\//i.test(url)) return url;
	const parsed = URL.parse(url);
	if (parsed === null) return url;
	parsed.username = "";
	parsed.password = "";
	return parsed.toString();
};

const decodeRepository = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Struct({ full_name: Schema.String, html_url: Schema.String, ssh_url: Schema.String })),
);

const make = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const git = yield* Git.Service;
	const home = homedir();
	// Projects are the user's work, so they live in plain sight rather than in the CodeWork home.
	const info = { home, projects: path.join(home, "codework", "projects") };
	const resolve = (value: string) => path.resolve(expandTilde(value, path));
	const failed = (target: string) => (error: PlatformError.PlatformError) => fail(describe(error, target));
	const stat = (target: string) =>
		fs.stat(target).pipe(
			Effect.asSome,
			Effect.catchIf(
				(error) => error.reason._tag === "NotFound",
				() => Effect.succeedNone,
			),
			Effect.mapError(failed(target)),
		);

	const browse = Effect.fn("Host.browse")(function* (input: string) {
		const directory = resolve(input);
		const entries = yield* Effect.tryPromise({
			try: () => readdir(directory, { withFileTypes: true }),
			catch: (cause) => (cause instanceof Error && "code" in cause ? String(cause.code) : undefined),
		}).pipe(
			Effect.catchIf(
				(code) => code === "EACCES" || code === "EPERM",
				() => Effect.succeed([]),
			),
			Effect.mapError((code) =>
				fail(
					code === "ENOENT"
						? `${directory} does not exist.`
						: code === "ENOTDIR"
							? `${directory} is not a directory.`
							: `Could not read ${directory}.`,
				),
			),
		);
		return {
			path: directory,
			entries: entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }))
				.toSorted((a, b) => a.name.localeCompare(b.name)),
		};
	});

	const add = Effect.fn("Host.add")(function* (input: string) {
		const directory = resolve(input);
		const found = yield* stat(directory);
		if (Option.isNone(found)) {
			yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(failed(directory)));
		} else if (found.value.type !== "Directory") {
			return yield* fail(`${directory} is not a directory.`);
		}
		return { path: directory };
	});

	// A non-recursive mkdir claims a name atomically; a racer that loses moves on to the next.
	const claim = Effect.fn("Host.claim")(function* (slug: string) {
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const folder = path.join(info.projects, attempt === 1 ? slug : `${slug}-${attempt}`);
			const claimed = yield* fs.makeDirectory(folder).pipe(
				Effect.as(true),
				Effect.catchIf(
					(error) => error.reason._tag === "AlreadyExists",
					() => Effect.succeed(false),
				),
				Effect.mapError(failed(folder)),
			);
			if (claimed) return folder;
		}
		return yield* fail(`Every folder name for "${slug}" is taken in ${info.projects}.`);
	});

	/** A repository with a README; answers why the first commit was skipped, if it was. */
	const scaffold = Effect.fn("Host.scaffold")(function* (folder: string, name: string) {
		const configured = yield* git.exec(folder, ["config", "--get", "init.defaultBranch"]).pipe(
			Effect.map((result) => (result.exitCode === 0 ? result.text.trim() : "")),
			Effect.orElseSucceed(() => ""),
		);
		yield* git.init(folder, { branch: configured || "main" }).pipe(Effect.mapError((error) => fail(error.message)));
		const readme = path.join(folder, "README.md");
		yield* fs.writeFileString(readme, `# ${name}\n`).pipe(Effect.mapError(failed(readme)));
		// Named and forced, so a global ignore rule cannot leave the first commit empty.
		const added = yield* git
			.exec(folder, ["add", "--force", "--", "README.md"])
			.pipe(Effect.mapError(() => fail("Could not run git add.")));
		if (added.exitCode !== 0) return yield* fail(added.stderr.trim() || "git add failed.");
		const committed = yield* git.exec(folder, ["commit", "--message", "Initial commit"]).pipe(Effect.option);
		if (Option.isNone(committed)) return "Could not run git commit, so the first commit was skipped.";
		return committed.value.exitCode === 0 ? undefined : commitFailure(committed.value.stderr);
	});

	const create = Effect.fn("Host.create")(function* (input: string) {
		const name = input.trim();
		if (name.length === 0) return yield* fail("A project needs a name.");
		if (name.length > MAX_NAME) return yield* fail(`A project name is at most ${MAX_NAME} characters.`);
		yield* fs.makeDirectory(info.projects, { recursive: true }).pipe(Effect.mapError(failed(info.projects)));
		const folder = yield* claim(folderName(name));
		const commitError = yield* scaffold(folder, name).pipe(
			Effect.onError(() => fs.remove(folder, { recursive: true }).pipe(Effect.ignore)),
		);
		return { path: folder, ...(commitError === undefined ? {} : { commitError }) };
	});

	const gh = Effect.fn("Host.gh")(function* (args: ReadonlyArray<string>) {
		const handle = yield* spawner.spawn(
			ChildProcess.make("gh", [...args], {
				env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
				extendEnv: true,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		// Drained alongside the exit wait: a full pipe would otherwise stall gh.
		return yield* Effect.all(
			{
				exitCode: handle.exitCode,
				stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
				stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
			},
			{ concurrency: "unbounded" },
		);
	}, Effect.scoped);

	const status = Effect.fn("Host.status")(function* () {
		const version = yield* gh(["--version"]).pipe(Effect.option);
		if (Option.isNone(version) || version.value.exitCode !== 0) return { ready: false, hint: INSTALL_GH };
		const auth = yield* gh(["auth", "status"]).pipe(Effect.option);
		if (Option.isNone(auth) || auth.value.exitCode !== 0) return { ready: false, hint: LOGIN_GH };
		return { ready: true };
	});

	const lookup = Effect.fn("Host.lookup")(function* (repository: string) {
		const selector = parseRepository(repository);
		if (selector === undefined) return yield* fail(NOT_NAMED);
		const hostname = selector.host === "github.com" ? [] : ["--hostname", selector.host];
		const api = (args: ReadonlyArray<string>) =>
			gh(["api", ...hostname, ...args]).pipe(Effect.mapError(() => fail(INSTALL_GH)));
		let owner = selector.owner;
		if (owner === undefined) {
			const user = yield* api(["user", "--jq", ".login"]);
			owner = user.stdout.trim();
			if (user.exitCode !== 0 || owner.length === 0) {
				return yield* fail(user.stderr.trim() || "Could not read the signed-in GitHub user.");
			}
		}
		const result = yield* api([`repos/${owner}/${selector.name}`]);
		if (result.exitCode !== 0) {
			return yield* fail(
				/HTTP 404|Not Found/i.test(result.stderr) ? NOT_FOUND : result.stderr.trim() || "gh api failed.",
			);
		}
		const found = yield* decodeRepository(result.stdout).pipe(
			Effect.mapError(() => fail("GitHub answered with something other than a repository.")),
		);
		return { nameWithOwner: found.full_name, url: found.html_url, sshUrl: found.ssh_url };
	});

	const remote = Effect.fn("Host.remote")(function* (directory: string) {
		const url = yield* git.remote(directory);
		return url === undefined ? undefined : shownRemote(url);
	});

	return Service.of({ info, browse, add, create, status, lookup, remote });
});

// Git runs on the host; every call names its own directory, so the mount root is never read.
export const layer = Layer.effect(Service, make).pipe(Layer.provide(Git.defaultLayer("/")));
