import * as path from 'path'
import {Client} from '@modelcontextprotocol/client'
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio'

async function main() {
  const directory = path.resolve(__dirname, '../../sample')
  const client = new Client({name: 'speedscope-smoke', version: '1.0.0'})
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      'tsx',
      path.resolve(__dirname, 'mcp-server.ts'),
      '--profiles-dir',
      directory,
    ],
    cwd: path.resolve(__dirname, '..'),
    stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})
  try {
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result: any = await client.callTool({name, arguments: args}, {timeout: 180000})
      if (result.isError) throw new Error(result.content[0].text)
      return JSON.parse(result.content[0].text)
    }
    const started = Date.now()
    const summary = await call('load_profile', {
      filename: process.argv[2] ?? 'cachegrind.out._var_www_html_index_php.1784296190',
    })
    console.log(JSON.stringify({loadSeconds: (Date.now() - started) / 1000, summary}))
    const scope = {datasetId: summary.datasetId, profileIndex: 0}
    const functions = await call('find_functions', {...scope, query: 'get_init_settings', limit: 3})
    console.log(JSON.stringify({functions}))
    if (functions.rows.length > 0) {
      const functionKey = functions.rows[0].key
      const invocations = await call('function_invocations', {...scope, functionKey, limit: 2})
      console.log(
        JSON.stringify({
          totalInvocations: invocations.totalResults,
          selectedCosts: invocations.rows.map((row: any) => row.formattedTotal),
        }),
      )
      const detail = await call('node_details', {...scope, path: invocations.rows[0].path})
      console.log(
        JSON.stringify({
          selectedNode: detail.name,
          total: detail.formattedTotal,
          ancestorCount: detail.ancestors.length,
          descendants: detail.descendants,
        }),
      )
    }
  } finally {
    await client.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
