import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Plugin, Tool } from "../src/index.ts";
import { SandboxDriver, SandboxIO } from "../src/sandbox.ts";
import { noop as noProgress } from "../src/tool/progress.ts";

/**
 * The published surface, exercised the way a plugin author reaches it.
 *
 * The harness has its own tests for what it *does* with a plugin; what is pinned here is that a
 * third party can build one against this package alone -- the entry points resolve, `define`
 * keeps the definition intact, and a tool authored here is a registrable tool.
 */

const echo = Tool.make({
	name: "echo",
	description: "Echo a message back.",
	parameters: Schema.Struct({ message: Schema.String }),
	success: Schema.Struct({ message: Schema.String }),
	encodeContent: (success) => [{ type: "text", text: success.message }],
	handler: ({ message }) => Effect.succeed({ message }),
});

describe("Plugin.define", () => {
	it("returns the definition unchanged", () => {
		const setup = () => {};
		const plugin = Plugin.define({ id: "acme.tool.echo", kind: "tool", setup });
		expect(plugin).toEqual({ id: "acme.tool.echo", kind: "tool", setup });
	});

	it("orders every tool plugin before every prompt plugin", () => {
		// A prompt plugin indexes the tools registered before it, so the domain -- not the
		// position of the entry -- decides which runs first.
		expect(Plugin.rank("tool")).toBeLessThan(Plugin.rank("prompt"));
		expect(Object.keys(Plugin.domains)).toEqual(["tool", "prompt"]);
	});
});

describe("Tool", () => {
	it("registers a tool whose handler survives the erasure", async () => {
		const registered = Tool.register(echo);
		expect(registered.definition.name).toBe("echo");
		// `register` leaves exactly one requirement, the progress sink the executor provides.
		const result = await Effect.runPromise(
			registered
				.handler({ message: "hi" }, { callID: "call_1", toolName: "echo", rawArgs: { message: "hi" } })
				.pipe(Effect.provide(noProgress)),
		);
		expect(result).toEqual({ message: "hi" });
	});

	it("derives a provider-safe wire view", () => {
		const wire = Tool.toAikitTool(echo.definition);
		expect(wire.name).toBe("echo");
		expect(wire.parameters).toMatchObject({ type: "object", properties: { message: { type: "string" } } });
	});
});

describe("sandbox mount", () => {
	it("exposes the three tags a tool asks for, and nothing below them", () => {
		// The mount is the whole vocabulary: a tool asks for a filesystem, a shell and the
		// identity they act on -- never for a driver, an address or a provider SDK.
		expect(Object.keys(SandboxIO).sort()).toEqual(["Current", "FileSystem", "SandboxIO", "Shell"]);
	});

	it("names a driver so a sandbox package can be authored against the same surface", () => {
		expect(SandboxDriver.apiVersion).toBe(1);
		expect(SandboxDriver.Name.make("acme.vm")).toBe("acme.vm");
		expect(SandboxDriver.AbsolutePath.make("/workspace")).toBe("/workspace");
	});
});
