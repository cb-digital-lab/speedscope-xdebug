import {createHash} from 'crypto'
import {readFileSync} from 'fs'
import * as path from 'path'
import {performance} from 'perf_hooks'
import {importFromCallgrind} from '../src/import/callgrind'
import {BufferBackedTextFileContent} from '../src/import/utils'
import {CallTreeNode, Frame, Profile} from '../src/lib/profile'

// Include every frame and both complete trees, without serializing millions of
// nodes to JSON. Verification runs after the timed section.
function checksum(profile: Profile) {
  const hash = createHash('sha256')
  const frameIds = new Map<Frame, number>()
  profile.forEachFrame(frame => {
    frameIds.set(frame, frameIds.size)
    hash.update(
      JSON.stringify([
        frame.key,
        frame.name,
        frame.file,
        frame.line,
        frame.col,
        frame.getSelfWeight(),
        frame.getTotalWeight(),
        frame.getCallCount(),
      ]),
    )
  })
  const buffer = Buffer.allocUnsafe(48 * 1024)
  let offset = 0
  const write = (value: number) => {
    buffer.writeDoubleLE(value, offset)
    offset += 8
    if (offset === buffer.length) {
      hash.update(buffer)
      offset = 0
    }
  }
  for (const root of [profile.getAppendOrderCalltreeRoot(), profile.getGroupedCalltreeRoot()]) {
    const stack: CallTreeNode[] = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      write(frameIds.get(node.frame) ?? -1)
      write(node.getStartValue() ?? -1)
      write(node.getSelfWeight())
      write(node.getTotalWeight())
      write(node.children.length)
      write(node.isFrozen() ? 1 : 0)
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
    }
  }
  hash.update(buffer.subarray(0, offset))
  return hash.digest('hex')
}

const filename = process.argv[2]
if (!filename) throw new Error('Usage: benchmark-callgrind.ts <file> [--verify]')
const started = performance.now()
const bytes = readFileSync(filename)
const readMs = performance.now() - started
const decodeStarted = performance.now()
const buffer =
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
const contents = new BufferBackedTextFileContent(buffer as ArrayBuffer)
const decodeMs = performance.now() - decodeStarted
const parseStarted = performance.now()
const group = importFromCallgrind(contents, path.basename(filename))
const parseMs = performance.now() - parseStarted
const rssMiB = process.memoryUsage().rss / 1024 / 1024
if (group == null) throw new Error('No Xdebug metrics found')
const metrics = group.profiles.map(profile => {
  let functions = 0
  let occurrences = 0
  profile.forEachFrame(frame => {
    functions++
    occurrences += frame.getCallCount()
  })
  return {
    name: profile.getName(),
    total: profile.getTotalWeight(),
    functions,
    occurrences,
    checksum: process.argv.includes('--verify') ? checksum(profile) : undefined,
  }
})
console.log(JSON.stringify({bytes: bytes.length, readMs, decodeMs, parseMs, rssMiB, metrics}))
const budget = Number(process.env.PARSE_BUDGET_MS)
if (budget > 0 && parseMs > budget) {
  console.error(`Parsing exceeded the ${budget} ms budget`)
  process.exitCode = 1
}
