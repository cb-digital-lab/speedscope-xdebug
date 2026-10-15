#!/usr/bin/env node
import {appendFile, access, mkdir, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'

const usage = `Usage: node profile-suite.mjs --repo PATH --profiles-dir PATH --output NEW_DIR
       --file NAME [--file NAME] [--query TEXT] [--limit 10] [--timeout-ms 180000]

Collect profile analyses through the Speedscope MCP. No website is changed or contacted.
--query and --file can be repeated. The output directory must not already exist.`

async function main() {
  const {values} = parseArgs({
    options: {
      repo: {type: 'string'},
      'profiles-dir': {type: 'string'},
      output: {type: 'string'},
      file: {type: 'string', multiple: true},
      query: {type: 'string', multiple: true},
      limit: {type: 'string', default: '10'},
      'timeout-ms': {type: 'string', default: '180000'},
      help: {type: 'boolean', short: 'h'},
    },
  })
  if (values.help) return console.log(usage)
  for (const name of ['repo', 'profiles-dir', 'output']) {
    if (!values[name]) throw new Error(`Missing required option --${name}.\n${usage}`)
  }
  if (!values.file?.length) throw new Error(`At least one --file is required.\n${usage}`)
  const limit = Number(values.limit)
  const timeout = Number(values['timeout-ms'])
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('--limit must be an integer between 1 and 100')
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new Error('--timeout-ms must be a positive integer')
  const repo = path.resolve(values.repo)
  const profilesDir = path.resolve(values['profiles-dir'])
  const output = path.resolve(values.output)
  const server = path.join(repo, 'scripts/mcp-server.ts')
  await access(server)
  await access(profilesDir)
  const require = createRequire(path.join(repo, 'package.json'))
  const {Client} = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href)
  const {StdioClientTransport} = await import(
    pathToFileURL(require.resolve('@modelcontextprotocol/client/stdio')).href
  )
  const loader = require.resolve('tsx')
  await mkdir(path.dirname(output), {recursive: true})
  await mkdir(output)
  const logPath = path.join(output, 'mcp-responses.jsonl')
  const manifestPath = path.join(output, 'suite.json')
  await writeFile(logPath, '', {flag: 'wx'})
  const manifest = {
    startedAt: new Date().toISOString(),
    complete: false,
    sessionScopedIds: true,
    parameters: {
      repo,
      profilesDir,
      files: values.file,
      queries: values.query ?? [],
      limit,
      timeout,
    },
    profiles: [],
  }
  const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const client = new Client({
    name: 'profile-with-speedscope',
    version: '1.0.0',
  })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', loader, server, '--profiles-dir', profilesDir],
    cwd: repo,
    stderr: 'pipe',
  })
  // The server owns stdout for JSON-RPC. Consume stderr without mixing it into evidence.
  transport.stderr?.on('data', () => {})
  const call = async (tool, args = {}) => {
    const started = performance.now()
    const response = await client.callTool({name: tool, arguments: args}, {timeout})
    const text = response.content
      ?.filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n')
    const data = response.isError ? text : JSON.parse(text)
    await appendFile(
      logPath,
      JSON.stringify({
        tool,
        args,
        durationMs: performance.now() - started,
        isError: !!response.isError,
        data,
      }) + '\n',
    )
    if (response.isError) throw new Error(`${tool}: ${text}`)
    return data
  }
  await save()
  try {
    await client.connect(transport)
    const inventory = await call('list_profiles')
    const available = new Set(inventory.files)
    for (const filename of values.file) {
      if (!available.has(filename))
        throw new Error(`Profile not found in the MCP directory: ${filename}`)
    }
    for (const filename of values.file) {
      const started = performance.now()
      const summary = await call('load_profile', {filename})
      const profile = {
        filename,
        loadMs: performance.now() - started,
        summary,
        metrics: [],
      }
      manifest.profiles.push(profile)
      for (const metric of summary.profiles) {
        const scope = {
          datasetId: summary.datasetId,
          profileIndex: metric.profileIndex,
        }
        const result = {
          profileIndex: metric.profileIndex,
          unit: metric.unit,
          rankings: {},
          focus: [],
        }
        profile.metrics.push(result)
        for (const sort of ['self', 'total', 'count']) {
          result.rankings[sort] = await call('find_functions', {
            ...scope,
            query: '',
            sort,
            limit,
          })
        }
        result.roots = await call('call_tree', {
          ...scope,
          path: [],
          sort: 'total',
          limit,
        })
        for (const query of values.query ?? []) {
          const matches = await call('find_functions', {
            ...scope,
            query,
            sort: 'total',
            limit: Math.min(limit, 3),
          })
          const focus = {query, matches, functions: []}
          result.focus.push(focus)
          for (const frame of matches.rows) {
            const args = {
              ...scope,
              functionKey: frame.key,
              sort: 'total',
              limit,
            }
            const callers = await call('function_callers', args)
            const invocations = await call('function_invocations', args)
            const detail = invocations.rows.length
              ? await call('node_details', {
                  ...scope,
                  path: invocations.rows[0].path,
                })
              : null
            focus.functions.push({frame, callers, invocations, detail})
          }
        }
      }
      await save()
      console.log(
        JSON.stringify({
          filename,
          loadMs: profile.loadMs,
          metrics: summary.profiles.length,
        }),
      )
    }
    manifest.complete = true
  } catch (error) {
    manifest.error = error.message
    throw error
  } finally {
    manifest.finishedAt = new Date().toISOString()
    try {
      await client.close()
    } finally {
      await save()
    }
  }
  console.log(
    JSON.stringify({
      complete: true,
      manifest: manifestPath,
      responses: logPath,
    }),
  )
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
