/**
 * RFC 8628 device-code polling, shared by the Copilot and Codex logins.
 *
 * Both flows differ only in how a poll response is classified, so they pass a
 * `poll` that maps their own payloads onto one result type and this owns the
 * timing: the initial wait, the interval, `slow_down` backoff, the deadline,
 * and cancellation.
 */

const CANCEL_MESSAGE = "Login cancelled";
const TIMEOUT_MESSAGE = "Device authorization timed out";
const SLOW_DOWN_TIMEOUT_MESSAGE =
	"Device authorization timed out after one or more slow_down responses. This is often caused by clock drift in a VM or WSL; sync the clock and try again.";
const MINIMUM_INTERVAL_MS = 1000;
/** RFC 8628 §3.2: a server that omits `interval` means 5 seconds. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: `slow_down` means add 5 seconds. */
const SLOW_DOWN_INCREMENT_MS = 5000;

export type DeviceCodePollResult<T> =
	| { status: "pending" }
	| { status: "slow_down"; intervalSeconds?: number | undefined }
	| { status: "failed"; message: string }
	| { status: "complete"; value: T };

export type DeviceCodePollOptions<T> = {
	intervalSeconds?: number | undefined;
	expiresInSeconds?: number | undefined;
	/** RFC 8628 §3.3: wait one interval before the first poll. */
	waitBeforeFirstPoll?: boolean | undefined;
	poll: () => Promise<DeviceCodePollResult<T>>;
	signal?: AbortSignal | undefined;
};

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(CANCEL_MESSAGE));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error(CANCEL_MESSAGE));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function pollDeviceCode<T>(options: DeviceCodePollOptions<T>): Promise<T> {
	const deadline =
		typeof options.expiresInSeconds === "number"
			? Date.now() + options.expiresInSeconds * 1000
			: Number.POSITIVE_INFINITY;
	let intervalMs = Math.max(
		MINIMUM_INTERVAL_MS,
		Math.floor((options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000),
	);
	let slowDowns = 0;

	if (options.waitBeforeFirstPoll) {
		const remaining = deadline - Date.now();
		if (remaining > 0) await abortableSleep(Math.min(intervalMs, remaining), options.signal);
	}

	while (Date.now() < deadline) {
		if (options.signal?.aborted) throw new Error(CANCEL_MESSAGE);

		const result = await options.poll();
		if (result.status === "complete") return result.value;
		if (result.status === "failed") throw new Error(result.message);
		if (result.status === "slow_down") {
			slowDowns += 1;
			// Prefer the server's new minimum when it reports one: a purely
			// client-tracked interval can poll early forever under clock drift.
			intervalMs =
				typeof result.intervalSeconds === "number" &&
				Number.isFinite(result.intervalSeconds) &&
				result.intervalSeconds > 0
					? Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
					: Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INCREMENT_MS);
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await abortableSleep(Math.min(intervalMs, remaining), options.signal);
	}

	throw new Error(slowDowns > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
}
