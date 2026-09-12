import { beforeAll, describe } from "vite-plus/test";
import "../utils/env.ts";

/** Required runs report missing credentials per suite, without blocking other providers. */
export const remoteSuite = (credential: string, available: boolean) => (name: string, tests: () => void) => {
	const required = process.env.CODEWORK_SANDBOX_E2E_REQUIRED === "1";
	const suite = available || required ? describe : describe.skip;
	suite(name, () => {
		beforeAll(() => {
			if (!available) throw new Error(`${credential} is missing or invalid for ${name}`);
		});
		tests();
	});
};
