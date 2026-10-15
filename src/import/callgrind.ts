// This local fork reads Callgrind data as Xdebug per-invocation records.
// Xdebug emits completed calls before their callers (post-order). Reconstruct
// the hierarchy once and reuse it for time and memory. Inclusive edge costs
// can differ slightly from the sum of self costs because of rounding.
// No aggregate call-graph distribution or producer guessing is performed.

import {FrameInfo, Profile, ProfileGroup} from '../lib/profile'
import {PostOrderCallTreeProfileBuilder} from '../lib/post-order-profile'
import {ByteFormatter, TimeFormatter} from '../lib/value-formatters'
import {TextFileContent} from './utils'

interface CallgrindRecord {
  frame: FrameInfo
  self: number[]
  childCount: number
}

// Keep millions of completed calls outside the GC heap. Node IDs are one-based;
// zero denotes an absent child/sibling. Only function identities are objects.
const RECORD_CHUNK_BITS = 16
const RECORD_CHUNK_SIZE = 1 << RECORD_CHUNK_BITS
const RECORD_CHUNK_MASK = RECORD_CHUNK_SIZE - 1

interface RecordChunk {
  frames: Uint32Array
  firstChild: Uint32Array
  nextSibling: Uint32Array
  self: Float64Array[]
}

class CallgrindProfileBuilder {
  private chunks: RecordChunk[] = []
  private length = 0
  private pending: number[] = []
  private frames: FrameInfo[] = []
  private frameIds = new Map<FrameInfo, number>()

  constructor(
    private fileName: string,
    private eventNames: string[],
  ) {}

  append(record: CallgrindRecord) {
    const first = this.pending.length - record.childCount
    if (first < 0) {
      throw new Error(
        'Invalid Xdebug post-order profile: a caller references missing child records. Aggregated Callgrind files are not supported by this fork.',
      )
    }
    const index = this.length++
    const offset = index & RECORD_CHUNK_MASK
    if (offset === 0) {
      this.chunks.push({
        frames: new Uint32Array(RECORD_CHUNK_SIZE),
        firstChild: new Uint32Array(RECORD_CHUNK_SIZE),
        nextSibling: new Uint32Array(RECORD_CHUNK_SIZE),
        self: this.eventNames.map(() => new Float64Array(RECORD_CHUNK_SIZE)),
      })
    }
    const chunk = this.chunks[index >>> RECORD_CHUNK_BITS]
    let frameId = this.frameIds.get(record.frame)
    if (frameId === undefined) {
      frameId = this.frames.length
      this.frames.push(record.frame)
      this.frameIds.set(record.frame, frameId)
    }
    chunk.frames[offset] = frameId
    for (let i = 0; i < this.eventNames.length; i++) chunk.self[i][offset] = record.self[i]
    if (record.childCount > 0) {
      chunk.firstChild[offset] = this.pending[first]
      for (let i = first; i < this.pending.length - 1; i++) {
        const child = this.pending[i] - 1
        this.chunks[child >>> RECORD_CHUNK_BITS].nextSibling[child & RECORD_CHUNK_MASK] =
          this.pending[i + 1]
      }
      this.pending.length = first
    }
    this.pending.push(index + 1)
  }

  build(): Profile[] {
    this.frameIds.clear()
    const profiles = this.eventNames.map((name, index) => this.emitFromTopology(name, index))
    this.chunks.length = 0
    return profiles
  }

  private emitFromTopology(fieldName: string, eventIndex: number): Profile {
    const profile = new PostOrderCallTreeProfileBuilder()
    profile.setReconstructedTimeline(true)
    const unitMultiplier = this.configureProfile(profile, fieldName)

    let totalCumulative = 0
    const stack: number[] = []
    for (const root of this.pending) {
      let id = root
      while (id !== 0) {
        const index = id - 1
        const chunk = this.chunks[index >>> RECORD_CHUNK_BITS]
        const offset = index & RECORD_CHUNK_MASK
        profile.enterFrame(this.frames[chunk.frames[offset]])
        stack.push(id)
        id = chunk.firstChild[offset]
        if (id !== 0) continue
        do {
          const completed = stack.pop()! - 1
          const chunk = this.chunks[completed >>> RECORD_CHUNK_BITS]
          const offset = completed & RECORD_CHUNK_MASK
          totalCumulative += Math.max(0, chunk.self[eventIndex][offset] || 0)
          profile.leaveFrame(Math.round(totalCumulative * unitMultiplier))
          id = chunk.nextSibling[offset]
        } while (id === 0 && stack.length > 0)
      }
    }

    return profile.build()
  }

  private configureProfile(profile: PostOrderCallTreeProfileBuilder, fieldName: string): number {
    let unitMultiplier = 1
    if (fieldName === 'Time_(10ns)') {
      profile.setName(`${this.fileName} -- Time`)
      unitMultiplier = 10
      profile.setValueFormatter(new TimeFormatter('nanoseconds'))
    } else if (fieldName == 'Memory_(bytes)') {
      profile.setName(`${this.fileName} -- Memory`)
      profile.setValueFormatter(new ByteFormatter())
    } else {
      profile.setName(`${this.fileName} -- ${fieldName}`)
    }
    return unitMultiplier
  }
}

// In writing this, I initially tried to use the formal grammar described in
// section 3.2 of https://www.valgrind.org/docs/manual/cl-format.html, but
// stopped because most of the information isn't relevant for visualization, and
// because there's inconsistency between the grammar and subsequence
// descriptions.
//
// For example, the grammar for headers specifies all the valid header names,
// but then the writing below that mentions there may be a "totals" or "summary"
// header, which should be disallowed by the formal grammar.
//
// So, instead, I'm not going to bother with a formal parse. Since there are no
// real recursive structures in this file format, that should be okay.
class CallgrindParser {
  private lineIterator: Iterator<string>
  private lineNum = 0

  private eventNames: string[] | null = null
  private numEvents = 0

  private builder: CallgrindProfileBuilder | null = null
  private currentRecord: CallgrindRecord | null = null
  private selfCosts: number[] = []

  private filename: string | null = null
  private functionName: string | null = null

  private savedFileNames: {[id: string]: string} = {}
  private savedFunctionNames: {[id: string]: string} = {}
  private internedFrames = new Map<string, FrameInfo>()

  constructor(
    contents: TextFileContent,
    private importedFileName: string,
  ) {
    this.lineIterator = contents.splitLines()[Symbol.iterator]()
  }

  private nextLine(): string | null {
    const result = this.lineIterator.next()
    if (result.done) return null
    this.lineNum++
    return result.value
  }

  parse(): ProfileGroup | null {
    let line: string | null
    while ((line = this.nextLine()) !== null) {
      if (line.length === 0) continue
      const first = line.charCodeAt(0)
      // Xdebug overwhelmingly emits decimal costs and f*/c* assignments.
      // Avoid testing every such line against the header/comment grammar.
      if (first >= 48 && first <= 57) {
        if (this.parseSelfCostLine(line)) continue
      } else if (first === 102 || first === 99) {
        if (this.parseAssignmentLine(line)) continue
      }
      if (/^\s*#/.exec(line)) {
        // Line is a comment. Ignore it.
        continue
      }

      if (/^\s*$/.exec(line)) {
        // Line is empty. Ignore it.
        continue
      }

      if (this.parseHeaderLine(line)) {
        continue
      }

      if (this.parseAssignmentLine(line)) {
        continue
      }

      if (this.parseSelfCostLine(line)) {
        continue
      }

      throw new Error(`Unrecognized line "${line}" on line ${this.lineNum}`)
    }

    if (!this.eventNames) {
      return null
    }

    this.finishRecord()
    this.internedFrames.clear()
    return {
      name: this.importedFileName,
      indexToView: 0,
      profiles: this.builder!.build(),
    }
  }

  private internFrame(file: string, name: string): FrameInfo {
    const key = `${file}:${name}`
    let info = this.internedFrames.get(key)
    if (info === undefined) {
      info = {key, name, file}
      this.internedFrames.set(key, info)
    }
    return info
  }

  private frameInfo(): FrameInfo {
    return this.internFrame(this.filename || '(unknown)', this.functionName || '(unknown)')
  }

  private beginRecord() {
    const record: CallgrindRecord = {
      frame: this.frameInfo(),
      self: this.selfCosts.fill(0),
      childCount: 0,
    }
    this.currentRecord = record
  }

  private finishRecord() {
    if (this.currentRecord !== null) {
      this.builder?.append(this.currentRecord)
      this.currentRecord = null
    }
  }

  private parseHeaderLine(line: string): boolean {
    const headerMatch = /^\s*(\w+):\s*(.*)+$/.exec(line)
    if (!headerMatch) return false

    if (headerMatch[1] === 'creator' && !/^xdebug\b/i.test(headerMatch[2])) {
      throw new Error('This fork supports Xdebug Callgrind profiles only.')
    }

    if (headerMatch[1] !== 'events') {
      // We don't care about other headers. Ignore this line.
      return true
    }

    // Line specifies the formatting of subsequent cost lines.
    const fields = headerMatch[2].split(' ')

    if (this.eventNames != null) {
      throw new Error(
        `Duplicate "events: " lines specified. First was "${this.eventNames.join(
          ' ',
        )}", now received "${line}" on ${this.lineNum}.`,
      )
    }

    this.eventNames = fields
    this.numEvents = fields.length
    this.selfCosts = new Array(this.numEvents).fill(0)
    this.builder = new CallgrindProfileBuilder(this.importedFileName, fields)

    return true
  }

  private parseAssignmentLine(line: string): boolean {
    const assignmentMatch = /^(\w+)=\s*(.*)$/.exec(line)
    if (!assignmentMatch) return false

    const key = assignmentMatch[1]
    const value = assignmentMatch[2]

    switch (key) {
      case 'fe':
      case 'fi': {
        // fe/fi are used to indicate the source-file of a function definition
        // changed mid-definition. This is for inlined code, but doesn't
        // indicate that we've actually switched to referring to a different
        // function, so we mostly ignore it.
        //
        // We still need to do the parseNameWithCompression call in case a name
        // is defined and then referenced later on for name compression.
        this.parseNameWithCompression(value, this.savedFileNames)
        break
      }

      case 'fl': {
        this.filename = this.parseNameWithCompression(value, this.savedFileNames)
        break
      }

      case 'fn': {
        this.finishRecord()
        this.functionName = this.parseNameWithCompression(value, this.savedFunctionNames)
        break
      }

      case 'cfi':
      case 'cfl': {
        // NOTE: unlike the fe/fi distinction described above, cfi and cfl are
        // interchangeable.
        this.parseNameWithCompression(value, this.savedFileNames)
        break
      }

      case 'cfn': {
        this.parseNameWithCompression(value, this.savedFunctionNames)
        break
      }

      case 'calls': {
        const calls = Number(value.trim().split(/\s+/)[0])
        if (!Number.isSafeInteger(calls) || calls < 0)
          throw new Error(`Invalid call count on line ${this.lineNum}`)
        const nums = this.parseCostNums(this.nextLine())
        if (nums == null) throw new Error(`Missing call cost on line ${this.lineNum}`)
        if (this.currentRecord == null) this.beginRecord()
        this.currentRecord!.childCount += calls
        break
      }

      case 'cob':
      case 'ob': {
        // We ignore these for now. They're valid lines, but we don't capture or
        // display information about them.
        break
      }

      default: {
        console.warn(`Ignoring assignment to unrecognized key "${line}" on line ${this.lineNum}`)
      }
    }

    return true
  }

  private parseNameWithCompression(name: string, saved: {[id: string]: string}): string {
    {
      const nameDefinitionMatch = /^\((\d+)\)\s*(.+)$/.exec(name)

      if (nameDefinitionMatch) {
        const id = nameDefinitionMatch[1]
        const name = nameDefinitionMatch[2]
        if (id in saved) {
          throw new Error(
            `Redefinition of name with id: ${id}. Original value was "${saved[id]}". Tried to redefine as "${name}" on line ${this.lineNum}.`,
          )
        }

        saved[id] = name
        return name
      }
    }

    {
      const nameUseMatch = /^\((\d+)\)$/.exec(name)
      if (nameUseMatch) {
        const id = nameUseMatch[1]
        if (!(id in saved)) {
          throw new Error(
            `Tried to use name with id ${id} on line ${this.lineNum} before it was defined.`,
          )
        }
        return saved[id]
      }
    }

    return name
  }

  private prevCostLineNumbers: number[] = []

  // NOTE: We intentionally do not include the line number (the leading position
  // field) in any frames, because callgrind uses the line number of the
  // function invocation, not the line number of the function definition, which
  // conflicts with how speedscope uses line numbers.
  private static numPositionFields = 1

  private parseSelfCostLine(line: string): boolean {
    const nums = this.parseCostNums(line)
    if (nums == null) return false

    if (this.currentRecord == null) {
      this.beginRecord()
    }

    for (let i = 0; i < this.numEvents; i++) {
      this.currentRecord!.self[i] += nums[i + CallgrindParser.numPositionFields] || 0
    }
    return true
  }

  private parseCostNums(line: string | null): number[] | null {
    if (line == null) return null
    const nums = this.costScratch
    nums.length = 0
    let index = 0
    while (index < line.length) {
      let value = 0
      const start = index
      let digit: number
      while (index < line.length && (digit = line.charCodeAt(index) - 48) >= 0 && digit <= 9) {
        value = value * 10 + digit
        index++
      }
      if (index === start || !Number.isSafeInteger(value)) return this.parseCostNumsSlow(line)
      nums.push(value)
      if (index === line.length) break
      if (line.charCodeAt(index++) !== 32 || index === line.length)
        return this.parseCostNumsSlow(line)
    }
    if (nums.length === 0) return null
    this.costScratch = this.prevCostLineNumbers
    this.prevCostLineNumbers = nums
    return nums
  }

  private costScratch: number[] = []

  private parseCostNumsSlow(line: string): number[] | null {
    // TODO(jlfwong): Allow hexadecimal encoding

    const parts = line.split(/\s+/)
    const nums: number[] = []

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]

      if (part.length === 0) {
        return null
      }

      if (part === '*' || part[0] === '-' || part[1] === '+') {
        // This handles "Subposition compression"
        // See: https://valgrind.org/docs/manual/cl-format.html#cl-format.overview.compression2
        if (this.prevCostLineNumbers.length <= i) {
          throw new Error(
            `Line ${this.lineNum} has a subposition on column ${i} but ` +
              `previous cost line has only ${this.prevCostLineNumbers.length} ` +
              `columns. Line contents: ${line}`,
          )
        }
        const prevCostForSubposition = this.prevCostLineNumbers[i]
        if (part === '*') {
          nums.push(prevCostForSubposition)
        } else {
          // This handles both the '-' and '+' cases
          const offset = parseInt(part)
          if (isNaN(offset)) {
            throw new Error(
              `Line ${this.lineNum} has a subposition on column ${i} but ` +
                `the offset is not a number. Line contents: ${line}`,
            )
          }
          nums.push(prevCostForSubposition + offset)
        }
      } else {
        const asNum = parseInt(part)
        if (isNaN(asNum)) {
          return null
        }
        nums.push(asNum)
      }
    }

    if (nums.length == 0) {
      return null
    }

    this.prevCostLineNumbers = nums
    return nums
  }
}

export function importFromCallgrind(
  contents: TextFileContent,
  importedFileName: string,
): ProfileGroup | null {
  if (contents.releaseRawBuffer) {
    contents.releaseRawBuffer()
  }
  return new CallgrindParser(contents, importedFileName).parse()
}
