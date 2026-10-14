import * as path from 'path'
import {serveStdio} from '@modelcontextprotocol/server/stdio'
import {createSpeedscopeServer} from '../src/mcp/server'

const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--profiles-dir')) {
  console.error('Usage: node --import tsx scripts/mcp-server.ts [--profiles-dir /path/to/profiles]')
  process.exit(1)
}
const directory = path.resolve(args[1] ?? path.join(__dirname, '../../sample'))
const handle = serveStdio(() => createSpeedscopeServer(directory))
process.on('SIGINT', () => {
  void handle.close()
})
process.on('SIGTERM', () => {
  void handle.close()
})
