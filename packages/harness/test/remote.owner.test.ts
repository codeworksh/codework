import { describe, expect, it } from "vite-plus/test";
import { makeRemoteOwner } from "./fixtures/remote-owner.ts";

describe("remote fixture owner", () => {
	it("deletes the captured resource before disposing its runtime", async () => {
		const owner = makeRemoteOwner("test");
		const calls: string[] = [];
		owner.capture("resource-1");

		await owner.cleanup({
			destroy: async (locator) => {
				calls.push(`destroy:${locator}`);
			},
			dispose: async () => {
				calls.push("dispose");
			},
		});

		expect(calls).toEqual(["destroy:resource-1", "dispose"]);
	});

	it("still disposes and reports a deletion failure", async () => {
		const owner = makeRemoteOwner("test");
		const deletion = new Error("delete failed");
		let disposed = false;
		owner.capture("resource-1");

		await expect(
			owner.cleanup({
				destroy: async () => {
					throw deletion;
				},
				dispose: async () => {
					disposed = true;
				},
			}),
		).rejects.toBe(deletion);
		expect(disposed).toBe(true);
	});

	it("aggregates deletion and disposal failures", async () => {
		const owner = makeRemoteOwner("test");
		const deletion = new Error("delete failed");
		const disposal = new Error("dispose failed");
		owner.capture("resource-1");

		const failure = await owner
			.cleanup({
				destroy: async () => {
					throw deletion;
				},
				dispose: async () => {
					throw disposal;
				},
			})
			.catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([deletion, disposal]);
	});

	it("reports an uncaptured locator without skipping disposal", async () => {
		const owner = makeRemoteOwner("test");
		let disposed = false;

		await expect(
			owner.cleanup({
				destroy: async () => {
					throw new Error("unreachable");
				},
				dispose: async () => {
					disposed = true;
				},
			}),
		).rejects.toThrow("resource locator was never captured");
		expect(disposed).toBe(true);
	});
});
