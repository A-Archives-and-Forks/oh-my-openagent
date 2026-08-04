# codex P2 follow-up: normalize suffixes before the provider capability lookup

Review comment: https://github.com/code-yeongyu/oh-my-openagent/pull/6485#discussion_r3709065480
Captured 2026-08-04 on Windows 11, bun 1.3.12.

## The defect this closes (introduced by this PR's own family fallback)

`get-model-capabilities.ts` passed the RAW `input.modelID` to
`providerCache.findProviderModelMetadata`, while the snapshot lookup and family
detection both use the canonical id. The connected-providers adapter matches
exactly (`packages/omo-opencode/src/shared/connected-providers-cache.ts:254` and
`:260` compare `entry === modelID` / `entry.id === modelID`), so a request for
`o3:high` never finds a cache entry for `o3`.

Before this PR that only meant `supportsTemperature` stayed undefined and the
configured temperature was preserved. With the family fallback this PR adds, an
undefined value now hands the decision to heuristics, so a provider that explicitly
advertises the bare model as temperature-capable would have had its temperature
deleted. Explicit provider metadata must win over family inference.

## Fix

Try the exact id first (so an explicitly suffixed cache entry still wins), then fall
back to the suffix-stripped form. Product diff: 1 file, +20/-1.

## RED (product change reverted, test kept)

```
bun test v1.3.14 (0d9b296a)
bun : 
At line:8 char:8
+ $red = bun test $T 2>&1 | Out-String
+        ~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
packages\model-core\src\model-capabilities-suffixed-provider-lookup.test.ts:
22 | 
23 |     // when
24 |     const capabilities = getModelCapabilities({ providerID: "openai", modelID: "o3:high", providerCache })
25 | 
26 |     // then
27 |     expect(capabilities.supportsTemperature).toBe(true)
                                                  ^
error: expect(received).toBe(expected)

Expected: true
Received: undefined

      at <anonymous> 
(C:\Users\pss\.omo-contrib\work\omo\packages\model-core\src\model-capabilities-suffixed-provider-lookup.test.ts:27:46)
(fail) getModelCapabilities provider lookup for suffixed model ids > #given a provider advertising the bare model 
#when a colon-suffixed id is requested #then the provider metadata still resolves [10.96ms]
35 |     // when
36 |     const parenthesized = getModelCapabilities({ providerID: "openai", modelID: "o3(high)", providerCache })
37 |     const spaced = getModelCapabilities({ providerID: "openai", modelID: "o3 high", providerCache })
38 | 
39 |     // then
40 |     expect(parenthesized.supportsTemperature).toBe(true)
                                                   ^
error: expect(received).toBe(expected)

Expected: true
Received: undefined

      at <anonymous> 
(C:\Users\pss\.omo-contrib\work\omo\packages\model-core\src\model-capabilities-suffixed-provider-lookup.test.ts:40:47)
(fail) getModelCapabilities provider lookup for suffixed model ids > #given a provider advertising the bare model 
#when a parenthesized or spaced suffix is requested #then the provider metadata still resolves [3.43ms]

 2 pass
 2 fail
 4 expect() calls
Ran 4 tests across 1 file. [764.00ms]
```

## GREEN (fix restored)

```
bun test v1.3.14 (0d9b296a)
bun : 
At line:10 char:10
+ $green = bun test $T 2>&1 | Out-String
+          ~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
 4 pass
 0 fail
 6 expect() calls
Ran 4 tests across 1 file. [627.00ms]
```

## Regression: full model-core suite

```
 342 pass
 0 fail
```

typecheck:packages exit=0

## Guards pinned by the new tests

- an exact suffixed cache entry still wins over the bare model (precedence preserved)
- when neither form matches, temperature stays unresolved (no new inference introduced)