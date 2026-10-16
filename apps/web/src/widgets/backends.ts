import type { Backend } from "@codeworksh/widget/backend";

import { session } from "./session/backend.ts";

/** Backends of the widgets that ship with the app; the app server starts each one. */
export const backends: ReadonlyArray<Backend> = [session];
