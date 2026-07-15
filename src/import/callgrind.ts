// https://www.valgrind.org/docs/manual/cl-format.html
//
// Larger example files can be found by searching on github:
// https://github.com/search?q=cfn%3D&type=code
//
// Converting callgrind files into flamegraphs is challenging because callgrind
// formatted profiles contain call graphs with weighted nodes and edges, and
// such a weighted call graph does not uniquely define a flamegraph.
//
// Consider a program that looks like this:
//
//    // example.js
//    function backup(read) {
//      if (read) {
//        read()
//      } else {
//        write()
//      }
//    }
//
//    function start() {
//       backup(true)
//    }
//
//    function end() {
//       backup(false)
//    }
//
//    start()
//    end()
//
// Profiling this program might result in a profile that looks like the
// following flame graph defined in Brendan Gregg's plaintext format:
//
//    start;backup;read 4
//    end;backup;write 4
//
// When we convert this execution into a call-graph, we get the following:
//
//      +------------------+     +---------------+
//      | start (self: 0)  |     | end (self: 0) |
//      +------------------+     +---------------|
//                   \               /
//        (total: 4)  \             / (total: 4)
//                     v           v
//                 +------------------+
//                 | backup (self: 0) |
//                 +------------------+
//                    /            \
//       (total: 4)  /              \ (total: 4)
//                  v                v
//      +----------------+      +-----------------+
//      | read (self: 4) |      | write (self: 4) |
//      +----------------+      +-----------------+
//
// In the process of the conversion, we've lost information about the ratio of
// time spent in read v.s. write in the start call v.s. the end call. The
// following flame graph would yield the exact same call-graph, and therefore
// the exact sample call-grind formatted profile:
//
//    start;backup;read 3
//    start;backup;write 1
//    end;backup;read 1
//    end;backup;write 3
//
// This is unfortunate, since it means we can't produce a flamegraph that isn't
// potentially lying about the what the actual execution behavior was. To
// produce a flamegraph at all from the call graph representation, we have to
// decide how much weight each sub-call should have. Given that we know the
// total weight of each node, we'll make the incorrect assumption that every
// invocation of a function will have the average distribution of costs among
// the sub-function invocations. In the example given, this means we assume that
// every invocation of backup() is assumed to spend half its time in read() and
// half its time in write().
//
// So the flamegraph we'll produce from the given call-graph will actually be:
//
//    start;backup;read 2
//    start;backup;write 2
//    end;backup;read 2
//    end;backup;write 2
//
// A particularly bad consequence is that the resulting flamegraph will suggest
// that there was at some point a call stack that looked like
// strat;backup;write, even though that never happened in the real program
// execution.
//
// This lossy behavior only applies to files that genuinely contain an
// aggregated call graph (e.g. those produced by valgrind/callgrind). Some
// producers -- notably Xdebug -- instead emit a separate cost record for each
// distinct invocation, in the order the calls complete (post-order: a callee's
// record always precedes its caller's). When that's the case, the true call
// tree can be reconstructed exactly by matching each caller's call edge to the
// specific callee record whose inclusive cost it reports. We detect that
// situation and reconstruct the real tree, falling back to the lossy
// even-distribution heuristic only for individual edges we can't resolve.

import {CallTreeProfileBuilder, Frame, FrameInfo, Profile, ProfileGroup} from '../lib/profile'
import {getOrInsert, KeyedSet} from '../lib/utils'
import {ByteFormatter, TimeFormatter} from '../lib/value-formatters'
import {TextFileContent} from './utils'

interface CallgrindRecord {
  frame: FrameInfo
  self: number[]
  childCount: number
  edgeCallees: FrameInfo[]
  edgeCalls: number[]
  edgeInclusive: number[]
}

interface TreeNode {
  frame: Frame
  selfWeight: number
  totalWeight: number
  children: TreeNode[]
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
    private knownReconstructable: boolean,
  ) {}

  build(): Profile[] {
    let canReconstruct = this.knownReconstructable
    if (!canReconstruct) {
      const recordsPerFrame = new Map<string | number, number>()
      for (const record of this.records) {
        recordsPerFrame.set(record.frame.key, (recordsPerFrame.get(record.frame.key) ?? 0) + 1)
      }
      for (const count of recordsPerFrame.values()) {
        if (count > 1) {
          canReconstruct = true
          break
        }
      }
    }

    if (canReconstruct) {
      for (const record of this.records) {
        record.edgeCallees = []
        record.edgeCalls = []
        record.edgeInclusive = []
      }
      const topology = this.buildTopology()
      this.records.length = 0
      return this.eventNames.map((name, index) => this.emitFromTopology(topology, name, index))
    }

    return this.eventNames.map((name, index) => this.buildHeuristicProfile(name, index))
  }

  private buildTopology(): TopologyNode[] {
    const pending: TopologyNode[] = []

    for (const record of this.records) {
      let childCount = record.childCount
      if (childCount > pending.length) {
        childCount = pending.length
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

  private buildHeuristicProfile(fieldName: string, eventIndex: number): Profile {
    const frameSet = new KeyedSet<Frame>()
    const getFrame = (info: FrameInfo): Frame => Frame.getOrInsert(frameSet, info)

    const totalWeights = new Map<Frame, number>()
    const childrenTotalWeights = new Map<Frame, Map<Frame, number>>()
    const addTotal = (frame: Frame, weight: number) => {
      totalWeights.set(frame, (totalWeights.get(frame) ?? 0) + weight)
    }

    for (const record of this.records) {
      const frame = getFrame(record.frame)
      addTotal(frame, record.self[eventIndex] || 0)
      const numEvents = this.eventNames.length
      for (let i = 0; i < record.edgeCallees.length; i++) {
        const child = getFrame(record.edgeCallees[i])
        const childMap = getOrInsert(childrenTotalWeights, frame, () => new Map<Frame, number>())
        const weight = record.edgeInclusive[i * numEvents + eventIndex] || 0
        childMap.set(child, (childMap.get(child) ?? 0) + weight)
        addTotal(frame, weight)
      }
    }

    let maxWeight = 0
    for (const [, weight] of totalWeights) {
      maxWeight = Math.max(maxWeight, weight)
    }

    const buildHeuristicSubtree = (
      frame: Frame,
      subtreeTotalWeight: number,
      currentStack: Set<Frame>,
    ): TreeNode | null => {
      // Call-graphs are allowed to have cycles. Call-trees are not. If we run
      // into a cycle, avoid recursing into the same subtree more than once in a
      // call stack; the time is instead attributed as self time in the parent.
      if (currentStack.has(frame)) {
        return null
      }

      // The even-distribution assumption can generate a call tree with
      // dramatically more nodes than the call graph, so we ignore subtrees
      // whose weight is less than 0.01% of the heaviest node in the graph.
      if (subtreeTotalWeight < 1e-4 * maxWeight) {
        return null
      }

      const graphTotal = totalWeights.get(frame) ?? 0
      if (graphTotal === 0) {
        return null
      }

      const children: TreeNode[] = []
      let childrenTotal = 0

      currentStack.add(frame)
      for (const [child, childGraphWeight] of childrenTotalWeights.get(frame) || []) {
        const childCallTreeWeight = subtreeTotalWeight * (childGraphWeight / graphTotal)
        const childNode = buildHeuristicSubtree(child, childCallTreeWeight, currentStack)
        if (childNode) {
          children.push(childNode)
          childrenTotal += childNode.totalWeight
        }
      }
      currentStack.delete(frame)

      // Any weight not actually claimed by a subtree (due to pruning or cycles)
      // is absorbed into self, so we don't lose weight in the call tree.
      return {
        frame,
        selfWeight: subtreeTotalWeight - childrenTotal,
        totalWeight: subtreeTotalWeight,
        children,
      }
    }

    // A node is a root of a call tree if nothing calls it. This isn't always
    // correct for fully general call graphs, but it's right in practice.
    const rootNodes = new Set<Frame>(frameSet)
    for (const [, childMap] of childrenTotalWeights) {
      for (const [child] of childMap) {
        rootNodes.delete(child)
      }
    }

    const forest: TreeNode[] = []
    for (const rootNode of rootNodes) {
      const node = buildHeuristicSubtree(rootNode, totalWeights.get(rootNode) ?? 0, new Set())
      if (node) forest.push(node)
    }

    const profile = new CallTreeProfileBuilder()
    const unitMultiplier = this.configureProfile(profile, fieldName)

    let totalCumulative = 0
    const emit = (node: TreeNode) => {
      profile.enterFrame(node.frame, Math.round(totalCumulative * unitMultiplier))
      for (const child of node.children) {
        emit(child)
      }
      totalCumulative += Math.max(0, node.selfWeight)
      profile.leaveFrame(node.frame, Math.round(totalCumulative * unitMultiplier))
    }
    for (const root of forest) {
      emit(root)
    }

    return profile.build()
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
  private calleeFilename: string | null = null
  private calleeFunctionName: string | null = null

  private savedFileNames: {[id: string]: string} = {}
  private savedFunctionNames: {[id: string]: string} = {}
  private internedFrames = new Map<string, FrameInfo>()
  private seenFrameKeys = new Set<string>()
  private dropEdgeDetails = false

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
    this.seenFrameKeys.clear()
    const builder = new CallgrindProfileBuilder(
      this.importedFileName,
      this.eventNames,
      this.records,
      this.dropEdgeDetails,
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

  private calleeFrameInfo(): FrameInfo {
    return this.internFrame(
      this.calleeFilename || this.filename || '(unknown)',
      this.calleeFunctionName || '(unknown)',
    )
  }

  private beginRecord() {
    const frame = this.frameInfo()
    const key = String(frame.key)
    if (this.seenFrameKeys.has(key)) {
      if (!this.dropEdgeDetails) {
        this.dropEdgeDetails = true
        for (const record of this.records) {
          record.edgeCallees = []
          record.edgeCalls = []
          record.edgeInclusive = []
        }
      }
    } else {
      this.seenFrameKeys.add(key)
    }

    const record: CallgrindRecord = {
      frame,
      self: new Array(this.numEvents).fill(0),
      childCount: 0,
      edgeCallees: [],
      edgeCalls: [],
      edgeInclusive: [],
    }
    this.records.push(record)
    this.currentRecord = record
  }

  private parseHeaderLine(line: string): boolean {
    const headerMatch = /^\s*(\w+):\s*(.*)+$/.exec(line)
    if (!headerMatch) return false

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
        this.beginRecord()
        break
      }

      case 'cfi':
      case 'cfl': {
        // NOTE: unlike the fe/fi distinction described above, cfi and cfl are
        // interchangeable.
        this.calleeFilename = this.parseNameWithCompression(value, this.savedFileNames)
        break
      }

      case 'cfn': {
        this.calleeFunctionName = this.parseNameWithCompression(value, this.savedFunctionNames)
        break
      }

      case 'calls': {
        const calls = parseInt(value.trim().split(/\s+/)[0]) || 1
        const nums = this.parseCostNums(this.nextLine())
        if (nums != null && this.currentRecord != null) {
          const record = this.currentRecord
          record.childCount += calls
          if (!this.dropEdgeDetails) {
            record.edgeCallees.push(this.calleeFrameInfo())
            record.edgeCalls.push(calls)
            const values = this.eventValues(nums)
            for (let i = 0; i < this.numEvents; i++) {
              record.edgeInclusive.push(values[i] || 0)
            }
          }
        }

        // This isn't specified anywhere in the spec, but empirically the
        // "cfn" scope should only persist for a single "call".
        //
        // This seems to be what KCacheGrind does too:
        //
        // https://github.com/KDE/kcachegrind/blob/ea4314db2785cb8f279fe884ee7f82445642b692/libcore/cachegrindloader.cpp#L1259
        this.calleeFilename = null
        this.calleeFunctionName = null
        break
      }

      case 'cob':
      case 'ob': {
        // We ignore these for now. They're valid lines, but we don't capture or
        // display information about them.
        break
      }

      default: {
        console.log(`Ignoring assignment to unrecognized key "${line}" on line ${this.lineNum}`)
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
