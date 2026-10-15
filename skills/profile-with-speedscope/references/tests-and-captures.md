# Comparative tests and new captures

## Define scenarios

Record the URL, actual target website, before/after variant, authenticated or
anonymous state, PHP/WordPress/plugin versions, HTTP method, and cache layers.
Track page cache, object cache, OPcache, static CSS, and browser cache separately.
A directory named "prod" does not identify the environment actually serving requests.

Identify a testable hypothesis and the measurement that distinguishes it.
Examples: a repeated function dominates self cost; CSS generation affects only
the first visit; a fix behaves differently with the Xdebug extension loaded.
Keep content and functional checks consistent between variants.

Reuse existing access and permissions. When a test affects shared caches,
configuration, or plugins, establish its concrete effects and authorized scope
before running it. Prefer an isolated test environment for purges and toggles.
The presence of this skill alone does not authorize production changes.

## Latency measurements without profiling

For a controlled local WordPress benchmark, start with 20 warm-up
requests excluded from results, then 300 sequential requests per batch across four
cycles, reversing A/B order every other cycle. Adapt duration and volume to the
website and question; analyzing a profile does not require this batch. Give each
pass its own warm-up, even when the variant has not changed.

Compare within the same runtime. To measure an improvement without Xdebug,
verify that the extension is actually absent from the PHP process responding
over HTTP. `XDEBUG_MODE=off` specifies a mode, not the absence of the extension.
PHP CLI observations do not establish the HTTP runtime's state.

Retain individual latencies, errors, status, TTFB, total time, response size, and
content checks. Record host load and timestamps. `ab -k` requests Keep-Alive;
verify actual connection reuse in the AB output. An HTTPS request from the local
machine does not by itself measure PHP time: document what each timer includes.

If page cache must be bypassed to test PHP, prove execution with a request nonce
returned by PHP and a corresponding server diagnostic, or equivalent evidence.
An old diagnostic header can itself be cached. If the goal is to measure page
cache performance, retain that layer and explicitly measure hit/miss scenarios.

Compare means, medians, P95 values, and differences by pair/cycle. Requests within
a batch share an environment; they are not independent experiments. Retain all
batches, including those that reverse the result. Stop a campaign if it hits the
wrong target, fails a functional check, or encounters transport/HTTP errors, then
explain why its results are invalid before continuing.

## Targeted Xdebug captures

1. Check the HTTP runtime's trigger configuration and output directory. Use the
   configured trigger for a targeted request; keep tokens in environment
   variables rather than displayed commands.
2. Reproduce the scenario's URL, anonymous/authenticated state, and cache states.
   Save metadata that confirms those states.
3. Collect one or a few representative captures per scenario, named by website,
   variant, cache state, repetition, and date. Verify that each file is new,
   complete, and attributable to its request, without overwriting an existing capture.
4. Copy the required files into the local directory exposed by the MCP; record
   the link between the request, diagnostic, and filename returned by `list_profiles`.
5. Return to the MCP workflow in `SKILL.md`, keeping profiled series separate
   from latency measurements without profiling.

The capture's HTTP duration, Xdebug costs, and local parsing time are three
different measurements. To determine the extension's own effect, compare a
fix A/B × extension absent/loaded matrix without triggering profiling, tracing,
or debugging. A profiled capture is an additional state. Verify the PHP binary's
identity and effective OPcache directives; similar Docker image tags do not prove
identical runtimes.

## First Elementor CSS generation

A batch of 300 visits after a single purge mostly measures warm behavior.
To isolate the first visit, repeat A/B pairs with alternating order. Ten pairs
are a starting point for this scenario; adapt to the test's cost.

Within each state: warm up, measure a warm control, then purge CSS. Use
`wp elementor flush-css`, without `--regenerate`, from the confirmed website
directory when supported by the target installation. Verify its behavior in the target installation and confirm that the
expected files have disappeared. Then time exactly one request before any other
visit, followed by its warm control. Purge after warm-up, otherwise warm-up has
already recreated the files.

Record purge duration separately. Confirm which documents were actually generated,
and check CSS hashes and functional rendering across variants. An Elementor purge
can also affect asset metadata/caches: attribute the measurement to the visit
following that operation, rather than to the CSS parser alone.

## Reusing test tools and cleanup

When the project already provides benchmark, capture, or setup scripts, inspect
and adapt their target URLs, paths, containers, probes, certificates, and toggles
before execution. Historical scripts document an experiment; their configuration
is neither a universal default nor proof of the current environment's state.
Keep customer and internal project identifiers out of reusable examples.

Record the initial state and remove only the probes, containers, and temporary
files created for the test. Restore temporarily changed states while retaining
the final choices explicitly requested by the user. Keep useful captures,
measurements, and reports; exclude cookies, secrets, and authentication headers
from shared artifacts.
