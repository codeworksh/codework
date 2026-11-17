/* @effect-diagnostics nodeBuiltinImport:off -- the suites spawn the real relay against Docker Postgres. */
import { createClerkClient } from "@clerk/backend";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
const envPath = fileURLToPath(new URL("../../../.env.local", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
export const secretKey = process.env.CLERK_SECRET_KEY;

const compose = (args: ReadonlyArray<string>) =>
	execFileSync("docker", ["compose", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Resolves with the first stdout line `match` accepts; rejects if the process exits first. */
export const waitForLine = (child: ChildProcess, match: (line: string) => string | undefined) =>
	new Promise<string>((resolve, reject) => {
		child.once("exit", (code) => reject(new Error(`process exited with ${code} before the expected output`)));
		createInterface({ input: child.stdout! }).on("line", (line) => {
			const found = match(line);
			if (found !== undefined) resolve(found);
		});
	});

/** A relay on a fresh database of the compose Postgres, at a free port. */
export const startRelay = async (run: string) => {
	const database = `relay_e2e_${run}`;
	compose(["up", "-d", "--wait"]);
	compose(["exec", "-T", "postgres", "psql", "-U", "relay", "-d", "relay", "-c", `CREATE DATABASE ${database}`]);
	const server = spawn(process.execPath, ["src/main.ts"], {
		cwd: root,
		env: { ...process.env, PORT: "0", DATABASE_URL: `postgres://relay:relay@127.0.0.1:55432/${database}` },
		stdio: ["ignore", "pipe", "inherit"],
	});
	const base = await waitForLine(server, (line) => /http:\/\/[\d.]+:\d+/.exec(line)?.[0]);
	return {
		base,
		psql: (query: string) =>
			compose(["exec", "-T", "postgres", "psql", "-U", "relay", "-d", database, "-tAc", query]).trim(),
		stop: () => {
			server.kill("SIGKILL");
			compose([
				"exec",
				"-T",
				"postgres",
				"psql",
				"-U",
				"relay",
				"-d",
				"relay",
				"-c",
				`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
			]);
		},
	};
};

/** A Clerk test user with a session; session tokens live a minute, so each call mints a fresh one. */
export const clerkUser = async (run: string) => {
	const clerk = createClerkClient({ secretKey: secretKey ?? "" });
	const user = await clerk.users.createUser({
		emailAddress: [`relay-e2e-${run}+clerk_test@example.com`],
		firstName: "Ada",
		lastName: "Lovelace",
		password: `Relay-e2e-${randomBytes(12).toString("hex")}`,
	});
	const session = await clerk.sessions.createSession({ userId: user.id });
	return {
		token: async () => (await clerk.sessions.getToken(session.id)).jwt,
		remove: () => clerk.users.deleteUser(user.id),
	};
};

export const newRun = () => randomBytes(4).toString("hex");
