/*
 * @file The lock on a plugin store entry or a settings file being edited.
 *
 * One lock per store entry, so two plugins install in parallel and two installs of one plugin do
 * not. A live install is never stolen from, however slow; one whose process died is taken over
 * after the timeout, and a waiter fails with a real error instead of hanging forever.
 */

import { Duration } from "effect";
import { Lock } from "../util/lock.ts";

const TIMEOUT = Duration.minutes(2);

/** Claims `directory` for the surrounding scope; `onTimeout` names the failure. */
export const lock = <E>(directory: string, onTimeout: () => E) =>
	Lock.acquire(directory, { stale: TIMEOUT, wait: TIMEOUT }, onTimeout);

export * as PluginLock from "./lock.ts";
