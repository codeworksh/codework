/*
 * Registry questions go to endpoints the npm CDN does not cache. `npm view` reads the full package
 * document, which is cached for up to five minutes (`max-age=300`), so a version published a
 * moment ago looks missing even with `--prefer-online`.
 */
const registry = "https://registry.npmjs.org";
const registryPath = (name) => name.replace("/", "%2f");

/** Whether `name@version` is on the registry: the per-version document is served uncached. */
export async function isPublished(name, version) {
	const response = await fetch(`${registry}/${registryPath(name)}/${version}`, {
		signal: AbortSignal.timeout(10_000),
	});
	if (response.status === 404) return false;
	if (!response.ok) throw new Error(`Registry lookup of ${name}@${version} failed: HTTP ${response.status}`);
	return true;
}

/** The package's dist-tags, mapping each tag to the version it points at. */
export async function distTags(name) {
	const response = await fetch(`${registry}/-/package/${registryPath(name)}/dist-tags`, {
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`Dist-tag lookup of ${name} failed: HTTP ${response.status}`);
	return response.json();
}
