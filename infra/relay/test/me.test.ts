import { Relay } from "@codeworksh/schema";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { clerkUser, newRun, secretKey, startRelay } from "./utils.ts";

const run = newRun();
const decodeMe = Schema.decodeUnknownSync(Relay.Me);
const decodeError = Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }));

let relay: Awaited<ReturnType<typeof startRelay>>;
let user: Awaited<ReturnType<typeof clerkUser>>;

const me = (bearer?: string) =>
	fetch(`${relay.base}/v1/me`, bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } });

describe.skipIf(secretKey === undefined)("relay /v1/me", () => {
	beforeAll(async () => {
		relay = await startRelay(run);
		user = await clerkUser(run);
	});

	afterAll(async () => {
		await user?.remove();
		relay?.stop();
	});

	it("creates one account and default workspace, even for concurrent first calls", async () => {
		const missing = await me();
		const forged = await me("not-a-token");

		const token = await user.token();
		const [first, second] = await Promise.all([me(token), me(token)]);
		const again = await me(token);
		const bodies = (await Promise.all([first.json(), second.json(), again.json()])).map((json) => decodeMe(json));

		expect([first.status, second.status, again.status]).toEqual([200, 200, 200]);
		expect(bodies[1]).toEqual(bodies[0]);
		expect(bodies[2]).toEqual(bodies[0]);

		const body = bodies[0]!;

		// A person who deletes their sign-in and signs up again with the same email is a new account.
		await user.remove();
		user = await clerkUser(run);
		const resignup = await me(await user.token());
		const resignupBody = resignup.status === 200 ? decodeMe(await resignup.json()) : undefined;

		// With the sign-in vendor out of reach a good token is "try again" (503), not "signed out" (401).
		const down = await startRelay(`${run}d`, { CLERK_API_URL: "http://127.0.0.1:9" });
		const vendorDown = await fetch(`${down.base}/v1/me`, {
			headers: { authorization: `Bearer ${await user.token()}` },
		});
		const vendorDownForged = await fetch(`${down.base}/v1/me`, { headers: { authorization: "Bearer not-a-token" } });
		const vendorDownBodies = [await vendorDown.json(), await vendorDownForged.json()].map((body) =>
			decodeError(body),
		);
		down.stop();

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
			resignup: {
				status: resignup.status,
				differentAccount: resignupBody !== undefined && resignupBody.account.id !== body.account.id,
				sameEmail: resignupBody?.account.email === body.account.email,
			},
			vendorDown: {
				token: { status: vendorDown.status, tag: vendorDownBodies[0]!._tag },
				forgedToken: { status: vendorDownForged.status, tag: vendorDownBodies[1]!._tag },
			},
			rows: {
				account: Number(relay.psql("SELECT count(*) FROM account")),
				workspace: Number(relay.psql("SELECT count(*) FROM workspace")),
				member: Number(relay.psql("SELECT count(*) FROM member")),
			},
		};
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/me.json");
	});
});
