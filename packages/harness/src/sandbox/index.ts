/**
 * The sandbox mount and driver contract, re-exported from `@codeworksh/plugin`.
 *
 * It lives there so a plugin's tools, and a third-party sandbox driver package, compile against
 * the same tags and codecs the harness mounts — not a structurally identical copy.
 */
export * from "@codeworksh/plugin/sandbox";
