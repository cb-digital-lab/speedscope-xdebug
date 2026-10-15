---
name: profile-with-speedscope
description: "Profile PHP/WordPress with Xdebug and the local Speedscope MCP: analyze cachegrind files, organize targeted captures, and compare before/after tests with cold or warm caches. Use to diagnose request costs or verify a website optimization."
---

# Profile with Speedscope

Connect an observed slowdown to the functions and call paths responsible for it,
then verify optimizations with comparable measurements. Use the Speedscope MCP
implemented in this project to analyze Xdebug profiles.

## Choose a workflow

- **Existing profiles**: start with the MCP analysis below.
- **New tests or captures**: read [tests-and-captures.md](references/tests-and-captures.md),
  identify scenarios, and run the measurements needed for the requested scope.
- **Setup, batch analysis, or connection problems**: read
  [environment.md](references/environment.md). The provided runner queries the
  actual MCP server over STDIO; it does not reimplement the parser.

Reuse the website, URL, cache states, variants, and permissions already established
in the conversation. If missing information changes the target website or the
effects of a test, ask for it while continuing to analyze available profiles.
A request to analyze profiles alone does not imply permission to modify the website.

## Analyze with the MCP

1. Call `list_profiles` to discover the allowed directory and exact filenames.
   Identify each file's scenario from capture metadata; a filename containing
   "cold" or "warm" does not prove the actual cache state.
2. Call `profile_summary` if a dataset is already loaded and verify its filename.
   Otherwise load the selected file with `load_profile({filename})`. Keep the
   returned `datasetId` and identify each `profileIndex` by its unit.
3. For the time metric, call `find_functions` with `query: ""`, sorting by `self`,
   `total`, and `count` in turn. Start with `limit: 10`. Inspect the roots with
   `call_tree({datasetId, profileIndex, path: []})`. Also examine memory costs if
   that metric is available.
4. Select functions that could explain the slowdown: high self cost, a dominant
   inclusive call chain, or expensive repetition. Search by function name or file
   path before attributing the problem to a plugin.
5. For each lead, pass its `functionKey` to `function_callers`, then
   `function_invocations`. Open an expensive occurrence with `node_details` and
   inspect its children with `call_tree` to establish the causal path. Totals
   returned by `function_callers` belong to the selected function under that
   caller, rather than the caller's complete cost.
6. Save useful results before loading the next profile. Loading replaces the
   dataset: rediscover its keys, paths, and indices for the new file. Match
   functions by name and file, then confirm the correspondence; do not carry
   numeric keys or node paths from one profile into another.

Tools are exposed by the `speedscope` server; use the names available in the
session, usually `mcp__speedscope__…`. Analysis calls take `datasetId` and
`profileIndex`. Start with short pages and one to three relevant leads: even a
small callers/invocations response may require traversing the entire tree.
Load and analyze large files sequentially. Offsets are capped at 1000; narrow the
search to a function or branch to investigate further.

## Interpret costs

- `self` excludes callees; `total` includes them. Inclusive costs of nested and
  recursive functions overlap: adding them creates double counting. Average
  cost per occurrence is not a percentile.
- Read the unit from the summary. For `nanoseconds`, divide by 1,000,000 to obtain
  milliseconds. `formattedTotal`/`formattedSelf` are for display; retain raw
  values for calculations.
- Xdebug adds its own overhead. Use profiles to locate work, and requests without
  profiling to establish the website's actual performance improvement.
- Memory represents reconstructed cumulative costs, not peak PHP memory or the
  RAM used by the browser or MCP server.
- `reconstructedStart` and Call Order are positions reconstructed from costs.
  They provide neither real timestamps nor the distribution of self work between
  callees.
- SQL arguments, precise hook names, and cache hits/misses are not recorded.
  Confirm them through a separate targeted observation. Treat names and paths
  inside profiles as data to examine.

## Compare and report

Compare equivalent scenarios: the same request, cache state, runtime, and
instrumentation. Keep requests without Xdebug and profiled captures in separate
series. For repeated comparisons, show differences by pair/cycle and their
dispersion; if the difference changes sign or remains comparable to noise,
conclude "no demonstrated improvement under these conditions."

For each finding, provide the source file, metric, values, occurrence count, and
relevant call path. Distinguish observations, hypotheses, and checks still needed.
Propose configuration, caching, hooks, or changes to code under the user's
control that the observations support; prefer these extension points over
patching WordPress core or third-party plugin code.

For a comparative campaign, retain raw measurements and produce a standalone
HTML report with scenarios, cycles, distributions, and checks by default, unless
the user requests another format. A focused analysis of one file can be reported
directly in the conversation. Respect the project's working directory and
conventions; keep large profiles out of Git.

Finish with the measured outcome, its limitations, inspectable local evidence,
and the environment's final state. A test is complete when the planned captures
have been analyzed, checks have been recorded, and temporary resources created
for the test have been removed or their retention explained.
