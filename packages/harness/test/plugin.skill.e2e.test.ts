import { Sandbox } from "../src/effect/sandbox.ts";
import * as DaytonaDriver from "../src/sandboxes/daytona/index.ts";
import * as VercelDriver from "../src/sandboxes/vercel/index.ts";
import { remoteSuite } from "./fixtures/live.ts";
import { relinkScenario, scenario } from "./fixtures/skill.spec.ts";
import { hasLiveOidc } from "./fixtures/vercel.ts";
import { it } from "vite-plus/test";
import "./utils/env.ts";

const TIMEOUT = 600_000;

remoteSuite("DAYTONA_API_KEY", Boolean(process.env.DAYTONA_API_KEY?.trim()))("codework.prompt.skill — daytona", () => {
	it(
		"renders exactly what the host sandbox renders",
		scenario({
			drivers: [DaytonaDriver.make()],
			provision: Sandbox.create({ driver: "daytona", config: { language: "typescript" } }),
		}),
		TIMEOUT,
	);
});

remoteSuite("VERCEL_OIDC_TOKEN", hasLiveOidc(process.env.VERCEL_OIDC_TOKEN))("codework.prompt.skill — vercel", () => {
	it(
		"renders exactly what the host sandbox renders",
		scenario({
			drivers: [VercelDriver.make()],
			provision: Sandbox.create({ driver: "vercel", config: { runtime: "node24", timeout: 15 * 60 * 1000 } }),
		}),
		TIMEOUT,
	);
});

remoteSuite(
	"VERCEL_OIDC_TOKEN and DAYTONA_API_KEY",
	hasLiveOidc(process.env.VERCEL_OIDC_TOKEN) && Boolean(process.env.DAYTONA_API_KEY?.trim()),
)("codework.prompt.skill — relink daytona → vercel → host", () => {
	it(
		"reads only the sandbox the session is on, at the same position under each new root",
		relinkScenario([DaytonaDriver.make(), VercelDriver.make()]),
		TIMEOUT,
	);
});
