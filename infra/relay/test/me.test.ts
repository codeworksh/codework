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
				account: Number(relay.psql("SELECT count(*) FROM account")),
				workspace: Number(relay.psql("SELECT count(*) FROM workspace")),
				member: Number(relay.psql("SELECT count(*) FROM member")),
			},
		};
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/me.json");
	});
});
