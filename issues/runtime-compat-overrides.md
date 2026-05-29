# Decouple Runtime Compat Overrides From Model Metadata

## Summary

Runtime compatibility overrides are currently merged into the returned `Model.Info` object. This works, but it mixes generated/static model metadata from `models.gen.json` with request-specific runtime overrides.

## Problem

`Model.getModel(provider, model, overrides)` returns a merged model object. For `compat`, the generated compat and runtime override compat are deep-merged into `model.compat`.

That makes it hard to tell which compat values came from:

- generated model metadata
- provider/base URL detection
- a runtime caller override

It also makes `model.compat` carry request-specific state, even though `Model.Info` is otherwise treated as reusable catalog data.

## Current Behavior

```ts
const model = await llm("openai", "gpt-4o-mini", {
	compat: {
		supportsStore: false,
	},
});
```

The returned model contains the merged compat:

```ts
model.compat.supportsStore === false;
```

## Proposed Behavior

Keep `model.compat` as generated/static metadata only, and pass runtime compat overrides separately into compat resolution.

Example API shape:

```ts
const model = await Model.getModel("openai", "gpt-4o-mini");
const compat = Model.resolveCompat(model, {
	supportsStore: false,
});
```

Resolution order should be explicit:

```ts
resolvedCompat = defaults + detected + generated + runtime;
```

Where later layers override earlier layers.

## Suggested Implementation

- Add an optional runtime compat parameter to `Model.resolveCompat`.
- Keep generated/static compat on `model.compat`.
- Stop merging runtime `overrides.compat` into the returned `Model.Info`.
- Pass runtime compat through provider options or a dedicated model runtime context.
- Share a protocol-level helper for layered compat resolution.

Sketch:

```ts
Model.resolveCompat(model, runtimeCompat);
```

```ts
function resolveCompatLayered<T extends object>(
	defaults: T,
	detected: Partial<T>,
	generated?: Partial<T>,
	runtime?: Partial<T>,
): T;
```

## Acceptance Criteria

- `model.compat` remains generated/static catalog metadata.
- Runtime compat overrides do not mutate or become indistinguishable from model metadata.
- `Model.resolveCompat` can apply runtime overrides as the final precedence layer.
- Existing generated compat behavior remains unchanged.
- Protocol adapters continue to receive fully resolved compat flags.
- Tests cover generated compat, runtime compat, and nested runtime overrides.

## Migration Notes

This can be introduced without breaking current callers by first supporting both paths:

- continue accepting `overrides.compat` in `getModel`
- internally preserve it as runtime override metadata
- later remove direct merging into `model.compat`

Once callers move to explicit runtime compat resolution, `getModel` can return catalog-shaped model data without request-specific compat mixed in.
