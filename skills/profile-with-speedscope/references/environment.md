# Environment and batch analysis

## Find the local setup

Locate the server repository from the current checkout, the MCP client's
configuration, or a path supplied by the user. Confirm that it contains
`scripts/mcp-server.ts` and the installed dependencies. Read `docs/mcp.md` in
that checkout for the maintained MCP documentation.

Connected tools are the first choice for interactive investigations.
`list_profiles` returns the directory actually configured. Copy a new capture
there under a unique name, then find it in the listing; the server rejects files
outside that directory, including symlinks that point outside it.

Keep workstation usernames, private directory layouts, customer identifiers,
and internal project names out of reusable instructions and public artifacts.
Use generic paths in examples and obtain actual paths only during execution.

The server analyzes Xdebug per-invocation records in post-order. It rejects
unsupported aggregated Callgrind producers. Report an import failure with its
observed error rather than silently converting the file to another cost model.

## Reproducible runner

The `../scripts/profile-suite.mjs` script opens its own MCP STDIO client against
the repository's server. It requires Node and the MCP/tsx dependencies installed
in that repository. It works from any directory and leaves an existing
interactive MCP connection intact.

```sh
node ~/.codex/skills/profile-with-speedscope/scripts/profile-suite.mjs \
  --repo /path/to/speedscope-xdebug \
  --profiles-dir /path/to/profiles \
  --output /path/to/a-new-directory \
  --file cachegrind-before \
  --file cachegrind-after \
  --query function_name
```

Get actual filenames from `list_profiles`. Both `--file` and `--query` can be
repeated. `--limit` defaults to 10 (maximum 100); `--timeout-ms` defaults to 180000
per MCP call. Without `--query`, the script saves rankings and roots; with a
query, it adds callers, occurrences, and details of the most expensive occurrence
for up to three matching functions.

The output directory must not already exist. It contains:

- `mcp-responses.jsonl`: bounded tool responses and call durations.
- `suite.json`: parameters, summaries by file/metric, and the `complete` state.

The script neither sends requests to a website nor produces a performance verdict:
`complete: true` means the requested MCP analyses succeeded. A query with no
results remains visible in `focus[].matches`. HTTP measurements still need to be
collected and compared with the profiles.

Recorded `datasetId` values and paths belong only to this MCP process. In another
session, reload the file and rediscover keys and paths. `loadMs` measures file
loading/analysis, not the duration of a PHP request.

## Missing or slow connection

Check `docs/mcp.md` and available tools before changing configuration. Start the
server manually with:

```sh
node --import /path/to/speedscope/node_modules/tsx/dist/loader.mjs \
  /path/to/speedscope/scripts/mcp-server.ts --profiles-dir /path/to/profiles
```

The transport is STDIO; the server reserves stdout for JSON-RPC. Restart a running
MCP process after changing the server's code. If a large capture exceeds the
timeout, inspect its state before starting the same load again; avoid concurrent
parsing and additional memory copies in a browser showing the same file.

To verify the server contract from its repository:

```sh
./node_modules/.bin/jest --runInBand src/mcp/server.test.ts
```

To measure the importer specifically, see the `benchmark:callgrind` command
documented in `docs/mcp.md`. This benchmark does not measure the website.
