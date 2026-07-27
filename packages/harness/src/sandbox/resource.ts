import { Context } from "effect";

/**
 * The driver's own locator for the attached resource — a Vercel sandbox name, a
 * Daytona sandbox id.
 *
 * Deliberately *not* on `SandboxIO.Current`: consumers never parse one, and §6.1
 * keeps it separate from the application id precisely so a driver's format can
 * change without touching identity. It exists for the control plane, which
 * records it as `provider_resource_id`, and for tests that reattach to the same
 * resource.
 *
 * One tag for every driver rather than one per driver. A mount has exactly one
 * driver, so there is nothing to disambiguate, and the control plane has to read
 * the locator without knowing which driver produced it — decision 5 keeps the
 * driver name open, so anything keyed on a closed `"vercel" | "daytona"` set is
 * a bug waiting for the third driver.
 */
export class Service extends Context.Service<Service, { readonly providerResourceId: string }>()(
	"@codework/sandbox/resource",
) {}

export * as SandboxResource from "./resource";
