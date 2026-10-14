// This local fork reads Callgrind data as Xdebug per-invocation records.
// Xdebug emits completed calls before their callers (post-order). Reconstruct
// the hierarchy once and reuse it for time and memory. Inclusive edge costs
// can differ slightly from the sum of self costs because of rounding.
// No aggregate call-graph distribution or producer guessing is performed.

import {CallTreeProfileBuilder, Frame, FrameInfo, Profile, ProfileGroup} from '../lib/profile'
import {KeyedSet} from '../lib/utils'
import {ByteFormatter, TimeFormatter} from '../lib/value-formatters'
import {TextFileContent} from './utils'

interface CallgrindRecord {
  frame: FrameInfo
  self: number[]
  childCount: number
}

interface TopologyNode {
  frameInfo: FrameInfo
  self: number[]
  children: TopologyNode[]
}

class CallgrindProfileBuilder {
  constructor(
    private fileName: string,
    private eventNames: string[],
    private records: CallgrindRecord[],
  ) {}

  build(): Profile[] {
    const topology = this.buildTopology()
    this.records.length = 0
    return this.eventNames.map((name, index) => this.emitFromTopology(topology, name, index))
  }

  private buildTopology(): TopologyNode[] {
    const pending: TopologyNode[] = []

    for (const record of this.records) {
      let childCount = record.childCount
      if (childCount > pending.length) {
        throw new Error(
          'Invalid Xdebug post-order profile: a caller references missing child records. Aggregated Callgrind files are not supported by this fork.',
        )
      }

      const children = childCount > 0 ? pending.splice(pending.length - childCount, childCount) : []
      pending.push({
        frameInfo: record.frame,
        self: record.self,
        children,
      })
    }

    return pending
  }

  private emitFromTopology(forest: TopologyNode[], fieldName: string, eventIndex: number): Profile {
    const frameSet = new KeyedSet<Frame>()
    const getFrame = (info: FrameInfo): Frame => Frame.getOrInsert(frameSet, info)
    const profile = new CallTreeProfileBuilder()
    profile.setReconstructedTimeline(true)
    const unitMultiplier = this.configureProfile(profile, fieldName)

    let totalCumulative = 0
    const emit = (node: TopologyNode) => {
      const frame = getFrame(node.frameInfo)
      profile.enterFrame(frame, Math.round(totalCumulative * unitMultiplier))
      for (const child of node.children) {
        emit(child)
      }
      totalCumulative += Math.max(0, node.self[eventIndex] || 0)
      profile.leaveFrame(frame, Math.round(totalCumulative * unitMultiplier))
    }
    for (const root of forest) {
      emit(root)
    }

    return profile.build()
  }

  private configureProfile(profile: CallTreeProfileBuilder, fieldName: string): number {
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

  private records: CallgrindRecord[] = []
  private currentRecord: CallgrindRecord | null = null

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

    this.internedFrames.clear()
    const builder = new CallgrindProfileBuilder(
      this.importedFileName,
      this.eventNames,
      this.records,
    )
    return {
      name: this.importedFileName,
      indexToView: 0,
      profiles: builder.build(),
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
      self: new Array(this.numEvents).fill(0),
      childCount: 0,
    }
    this.records.push(record)
    this.currentRecord = record
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
        this.functionName = this.parseNameWithCompression(value, this.savedFunctionNames)
        this.currentRecord = null
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

  private eventValues(nums: number[]): number[] {
    return nums.slice(CallgrindParser.numPositionFields)
  }

  private parseSelfCostLine(line: string): boolean {
    const nums = this.parseCostNums(line)
    if (nums == null) return false

    if (this.currentRecord == null) {
      this.beginRecord()
    }

    const values = this.eventValues(nums)
    for (let i = 0; i < this.numEvents; i++) {
      this.currentRecord!.self[i] += values[i] || 0
    }
    return true
  }

  private parseCostNums(line: string | null): number[] | null {
    // TODO(jlfwong): Allow hexadecimal encoding
    if (line == null) return null

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
