/** @jest-environment node */
import {promises as fs} from 'fs'
import * as os from 'os'
import * as path from 'path'
import {Client} from '@modelcontextprotocol/client'
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio'

test('MCP client can load, query, drill down and reject stale or out-of-directory requests', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'speedscope-mcp-'))
  const fixture = `creator: xdebug 3.5.0
events: Time_(10ns) Memory_(bytes)
fl=index.php
fn=child
1 3 20
fn=child
1 7 40
fn=main
1 5 10
cfn=child
calls=2 1
1 10 60
`
  await fs.writeFile(path.join(directory, 'cachegrind.test'), fixture)
  const client = new Client({name: 'speedscope-regression-tests', version: '1.0.0'})
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      path.resolve('node_modules/tsx/dist/loader.mjs'),
      path.resolve('scripts/mcp-server.ts'),
      '--profiles-dir',
      directory,
    ],
    cwd: directory,
    stderr: 'pipe',
  })
  try {
    await client.connect(transport)
    const toolNames = (await client.listTools()).tools.map(tool => tool.name)
    expect(toolNames).toContain('function_invocations')
    const call = async (name: string, args: any = {}) => {
      const response: any = await client.callTool({name, arguments: args})
      if (response.isError) throw new Error(response.content[0].text)
      return JSON.parse(response.content[0].text)
    }
    const loaded = await call('load_profile', {filename: 'cachegrind.test'})
    expect(loaded.profiles).toHaveLength(2)
    expect(loaded.profiles[0].occurrences).toBe(3)
    const scope = {datasetId: loaded.datasetId, profileIndex: 0}
    const functions = await call('find_functions', {...scope, query: 'child'})
    expect(functions.rows[0].occurrences).toBe(2)
    const key = functions.rows[0].key
    const invocations = await call('function_invocations', {...scope, functionKey: key, limit: 1})
    expect(invocations.totalResults).toBe(2)
    expect(invocations.rows[0].total).toBe(70)
    const second = await call('function_invocations', {
      ...scope,
      functionKey: key,
      offset: 1,
      limit: 1,
    })
    expect(second.rows[0].total).toBe(30)
    const selected = await call('node_details', {...scope, path: invocations.rows[0].path})
    expect(selected.name).toBe('child')
    expect(selected.ancestors[0].name).toBe('main')
    const tree = await call('call_tree', scope)
    expect(tree.rows[0].name).toBe('main')
    const callers = await call('function_callers', {...scope, functionKey: key})
    expect(callers.rows[0]).toMatchObject({occurrences: 2, total: 100})
    await expect(call('load_profile', {filename: path.resolve('package.json')})).rejects.toThrow(
      'configured profiles directory',
    )
    const reloaded = await call('load_profile', {filename: 'cachegrind.test'})
    expect(reloaded.datasetId).not.toBe(loaded.datasetId)
    await expect(call('node_details', {...scope, path: [0]})).rejects.toThrow('Stale dataset')
  } finally {
    await client.close()
    await fs.unlink(path.join(directory, 'cachegrind.test'))
    await fs.rmdir(directory)
  }
}, 20000)
