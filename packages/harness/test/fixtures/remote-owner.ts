export interface Cleanup {
	readonly destroy: (locator: string) => Promise<void>;
	readonly dispose: () => Promise<void>;
}

export const labels = (instanceId: string): Readonly<Record<string, string>> => ({
	"codework-instance": instanceId,
	"codework-managed": "true",
	"codework-test": "true",
});

/**
 * Owns one billable resource independently of the runtime that attaches to it.
 *
 * The locator is captured during provisioning, so teardown never has to ask a
 * possibly failed or already-disposed ManagedRuntime which resource to delete.
 * Process-level SIGKILL or CI cancellation can still skip `afterAll`; the
 * `codework-test` label is the compensating control for an orphan sweep.
 */
export const makeRemoteOwner = (label: string) => {
	let locator: string | undefined;

	const capture = (value: string): string => {
		if (locator !== undefined && locator !== value) {
			throw new Error(`${label} resource owner already captured ${locator}, cannot replace it with ${value}`);
		}
		locator = value;
		return value;
	};

	const cleanup = async ({ destroy, dispose }: Cleanup): Promise<void> => {
		const failures: unknown[] = [];
		if (locator === undefined) {
			failures.push(new Error(`${label} resource locator was never captured`));
		} else {
			try {
				await destroy(locator);
			} catch (cause) {
				failures.push(cause);
			}
		}

		try {
			await dispose();
		} catch (cause) {
			failures.push(cause);
		}

		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, `${label} resource cleanup failed`);
		}
	};

	return { capture, cleanup };
};
