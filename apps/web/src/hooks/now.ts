import { useSyncExternalStore } from "react";

import { type Clock, minuteTick, secondTick } from "@/kernel/clock";

const useClock = (clock: Clock) => useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);

/** Epoch ms floored to the minute, re-rendering once a minute. */
export const useNowMinute = () => useClock(minuteTick);

/** Epoch ms floored to the second, re-rendering once a second. */
export const useNowSecond = () => useClock(secondTick);
