/* @effect-diagnostics nodeBuiltinImport:off -- the suite spawns the real relay against Docker Postgres. */
import { createClerkClient } from "@clerk/backend";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Me } from "../src/api.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const envPath = fileURLToPath(new URL("../../../.env.local", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const secretKey = process.env.CLERK_SECRET_KEY;

const run = randomBytes(4).toString("hex");
const database = `relay_e2e_${run}`;
const psql = (query: string) =>
	execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "relay", "-d", database, "-tAc", query], {
		cwd: root,
		encoding: "utf8",
	}).trim();

let server: ChildProcess;
let base: string;
let userId: string;
let token: string;

const decodeMe = Schema.decodeUnknownSync(Me);
const decodeError = Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }));

const me = (bearer?: string) =>
	fetch(`${base}/v1/me`, bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } });

describe.skipIf(secretKey === undefined)("relay /v1/me", () => {
	const clerk = createClerkClient({ secretKey: secretKey ?? "" });

	beforeAll(async () => {
		execFileSync("docker", ["compose", "up", "-d", "--wait"], { cwd: root, stdio: "ignore" });
		execFileSync(
			"docker",
			[
				"compose",
				"exec",
				"-T",
				"postgres",
				"psql",
				"-U",
				"relay",
				"-d",
				"relay",
				"-c",
				`CREATE DATABASE ${database}`,
			],
			{ cwd: root, stdio: "ignore" },
		);

		server = spawn(process.execPath, ["src/main.ts"], {
			cwd: root,
			env: {
				...process.env,
				PORT: "0",
				DATABASE_URL: `postgres://relay:relay@127.0.0.1:55432/${database}`,
			},
			stdio: ["ignore", "pipe", "inherit"],
		});
		base = await new Promise<string>((resolve, reject) => {
			server.once("exit", (code) => reject(new Error(`relay exited with ${code}`)));
			createInterface({ input: server.stdout! }).on("line", (line) => {
				const match = /http:\/\/[\d.]+:\d+/.exec(line);
				if (match) resolve(match[0]);
			});
		});

		const user = await clerk.users.createUser({
			emailAddress: [`relay-e2e-${run}+clerk_test@example.com`],
			firstName: "Ada",
			lastName: "Lovelace",
			password: `Relay-e2e-${randomBytes(12).toString("hex")}`,
		});
		userId = user.id;
		const session = await clerk.sessions.createSession({ userId });
		token = (await clerk.sessions.getToken(session.id)).jwt;
	});

	afterAll(async () => {
		server?.kill("SIGKILL");
		if (userId !== undefined) await clerk.users.deleteUser(userId);
		execFileSync(
			"docker",
			[
				"compose",
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
			],
			{ cwd: root, stdio: "ignore" },
		);
	});

	it("creates one account and default workspace, even for concurrent first calls", async () => {
		const missing = await me();
		const forged = await me("not-a-token");

		const [first, second] = await Promise.all([me(token), me(token)]);
		const again = await me(token);
		const bodies = (await Promise.all([first.json(), second.json(), again.json()])).map((json) => decodeMe(json));

		expect([first.status, second.status, again.status]).toEqual([200, 200, 200]);
		expect(bodies[1]).toEqual(bodies[0]);
		expect(bodies[2]).toEqual(bodies[0]);

		const body = bodies[0]!;
		const artifact = {
			missingToken: { status: missing.status, tag: decodeError(await missing.json())._tag },
			forgedToken: { status: forged.status, tag: decodeError(await forged.json())._tag },
			me: {
				account: { id: "<account>", email: body.account.email.replace(run, "<run>"), name: body.account.name },
				workspaces: body.workspaces.map((workspace, index) => ({
					id: `<workspace-${index}>`,
					name: workspace.name,
					role: workspace.role,
				})),
			},
			rows: {
				account: Number(psql("SELECT count(*) FROM account")),
				workspace: Number(psql("SELECT count(*) FROM workspace")),
				member: Number(psql("SELECT count(*) FROM member")),
			},
		};
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/me.json");
	});
});
