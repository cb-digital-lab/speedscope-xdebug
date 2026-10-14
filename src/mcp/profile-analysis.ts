import {promises as fs} from 'fs'
import * as path from 'path'
import {CallTreeNode, Frame, Profile, ProfileGroup} from '../lib/profile'
import {importFromCallgrind} from '../import/callgrind'
import {BufferBackedTextFileContent} from '../import/utils'

export type CostSort = 'total' | 'self' | 'count'

function page<T>(rows: T[], offset: number, limit: number) {
  return {totalResults: rows.length, offset, rows: rows.slice(offset, offset + limit)}
}

function cost(node: {getTotalWeight(): number; getSelfWeight(): number}, sort: CostSort) {
  return sort === 'self' ? node.getSelfWeight() : node.getTotalWeight()
}

function walk(root: CallTreeNode, visit: (node: CallTreeNode) => void) {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (!node.isRoot()) visit(node)
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
  }
}

function nodePath(node: CallTreeNode) {
  const result: number[] = []
  for (let current = node; current.parent != null; current = current.parent) {
    result.push(current.parent.children.indexOf(current))
  }
  return result.reverse()
}

export class ProfileAnalysis {
  private frames: Frame[] = []
  constructor(private profile: Profile) {
    profile.forEachFrame(frame => this.frames.push(frame))
  }

  private frameInfo(frame: Frame) {
    return {key: frame.key, name: frame.name, file: frame.file ?? null, line: frame.line ?? null}
  }

  private timings(node: CallTreeNode | Frame) {
    const total = node.getTotalWeight()
    const self = node.getSelfWeight()
    const weight = this.profile.getTotalNonIdleWeight()
    return {
      total,
      self,
      formattedTotal: this.profile.formatValue(total),
      formattedSelf: this.profile.formatValue(self),
      totalPercent: weight > 0 ? (100 * total) / weight : 0,
      selfPercent: weight > 0 ? (100 * self) / weight : 0,
    }
  }

  summary() {
    return {
      name: this.profile.getName(),
      unit: this.profile.getWeightUnit(),
      total: this.profile.getTotalWeight(),
      formattedTotal: this.profile.formatValue(this.profile.getTotalWeight()),
      functions: this.frames.length,
      occurrences: this.frames.reduce((sum, frame) => sum + frame.getCallCount(), 0),
      roots: this.profile.getAppendOrderCalltreeRoot().children.length,
      timeline: 'reconstructed-from-xdebug-costs',
    }
  }

  functions(query: string, sort: CostSort, offset: number, limit: number) {
    const needle = query.toLocaleLowerCase()
    const frames = this.frames.filter(frame =>
      `${frame.name}\n${frame.file ?? ''}`.toLocaleLowerCase().includes(needle),
    )
    frames.sort(
      (a, b) =>
        (sort === 'count' ? b.getCallCount() - a.getCallCount() : cost(b, sort) - cost(a, sort)) ||
        String(a.key).localeCompare(String(b.key)),
    )
    return page(
      frames.map(frame => ({
        ...this.frameInfo(frame),
        ...this.timings(frame),
        occurrences: frame.getCallCount(),
      })),
      offset,
      limit,
    )
  }

  private getNode(indices: number[]) {
    let node = this.profile.getAppendOrderCalltreeRoot()
    for (const index of indices) {
      const child = node.children[index]
      if (child == null) throw new Error('Unknown node path in this profile')
      node = child
    }
    return node
  }

  private nodeInfo(node: CallTreeNode, indices: number[]) {
    return {
      ...this.frameInfo(node.frame),
      ...this.timings(node),
      path: indices,
      childCount: node.children.length,
      reconstructedStart: node.getStartValue(),
    }
  }

  children(indices: number[], sort: CostSort, offset: number, limit: number) {
    const parent = this.getNode(indices)
    const children = parent.children.map((node, index) => ({node, index}))
    children.sort((a, b) => cost(b.node, sort) - cost(a.node, sort) || a.index - b.index)
    const result = page(children, offset, limit)
    return {
      parent: this.nodeInfo(parent, indices),
      ...result,
      rows: result.rows.map(({node, index}) => this.nodeInfo(node, [...indices, index])),
    }
  }

  node(indices: number[]) {
    const node = this.getNode(indices)
    let descendants = 0
    walk(node, child => {
      if (child !== node) descendants++
    })
    const ancestors = []
    for (let parent = node.parent; parent != null && !parent.isRoot(); parent = parent.parent)
      ancestors.push(parent)
    return {
      ...this.nodeInfo(node, indices),
      descendants,
      ancestors: ancestors.reverse().map(parent => this.nodeInfo(parent, nodePath(parent))),
    }
  }

  private getFrame(key: string | number) {
    const frame = this.frames.find(candidate => candidate.key === key)
    if (frame == null) throw new Error('Unknown function key in this profile')
    return frame
  }

  invocations(key: string | number, sort: CostSort, offset: number, limit: number) {
    const frame = this.getFrame(key)
    const best: {node: CallTreeNode; order: number}[] = []
    const count = offset + limit
    let found = 0
    const compare = (a: (typeof best)[0], b: (typeof best)[0]) =>
      cost(b.node, sort) - cost(a.node, sort) || a.order - b.order
    walk(this.profile.getAppendOrderCalltreeRoot(), node => {
      if (node.frame !== frame) return
      const candidate = {node, order: found++}
      if (best.length >= count && compare(candidate, best[best.length - 1]) >= 0) return
      let left = 0,
        right = best.length
      while (left < right) {
        const middle = (left + right) >>> 1
        if (compare(candidate, best[middle]) < 0) right = middle
        else left = middle + 1
      }
      best.splice(left, 0, candidate)
      if (best.length > count) best.pop()
    })
    return {
      totalResults: found,
      offset,
      rows: best.slice(offset).map(({node, order}) => ({
        ...this.nodeInfo(node, nodePath(node)),
        callOrder: order,
        caller:
          node.parent != null && !node.parent.isRoot() ? this.frameInfo(node.parent.frame) : null,
      })),
    }
  }

  callers(key: string | number, sort: CostSort, offset: number, limit: number) {
    const frame = this.getFrame(key)
    const groups = new Map<
      Frame | null,
      {caller: Frame | null; total: number; self: number; occurrences: number}
    >()
    walk(this.profile.getAppendOrderCalltreeRoot(), node => {
      if (node.frame !== frame) return
      const caller = node.parent == null || node.parent.isRoot() ? null : node.parent.frame
      let group = groups.get(caller)
      if (group == null) {
        group = {caller, total: 0, self: 0, occurrences: 0}
        groups.set(caller, group)
      }
      group.total += node.getTotalWeight()
      group.self += node.getSelfWeight()
      group.occurrences++
    })
    const rows = Array.from(groups.values())
    rows.sort((a, b) => (sort === 'count' ? b.occurrences - a.occurrences : b[sort] - a[sort]))
    return page(
      rows.map(row => ({...row, caller: row.caller == null ? null : this.frameInfo(row.caller)})),
      offset,
      limit,
    )
  }
}

export class ProfileRepository {
  private group: ProfileGroup | null = null
  private analyses = new Map<number, ProfileAnalysis>()
  private revision = 0
  private filename = ''
  private loading = false

  constructor(readonly directory: string) {}

  async list() {
    const entries = await fs.readdir(this.directory, {withFileTypes: true})
    return {
      directory: this.directory,
      files: entries
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .sort(),
    }
  }

  async load(filename: string) {
    if (this.loading) throw new Error('Another profile is loading')
    this.loading = true
    try {
      const root = await fs.realpath(this.directory)
      const file = await fs.realpath(path.resolve(root, filename))
      const relative = path.relative(root, file)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error('Profile must be inside the configured profiles directory')
      const bytes = await fs.readFile(file)
      this.group = null
      this.analyses.clear()
      const buffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      const group = importFromCallgrind(
        new BufferBackedTextFileContent(buffer as ArrayBuffer),
        path.basename(file),
      )
      if (group == null || group.profiles.length === 0)
        throw new Error('No Xdebug metrics found in this file')
      this.group = group
      this.filename = file
      this.revision++
      return this.summary()
    } finally {
      this.loading = false
    }
  }

  get(datasetId: string, profileIndex: number) {
    if (this.group == null) throw new Error('Load an Xdebug profile first')
    if (datasetId !== `dataset-${this.revision}`)
      throw new Error('Stale dataset ID; get the current profile summary')
    const profile = this.group.profiles[profileIndex]
    if (profile == null) throw new Error('Unknown metric index')
    let analysis = this.analyses.get(profileIndex)
    if (analysis == null) {
      analysis = new ProfileAnalysis(profile)
      this.analyses.set(profileIndex, analysis)
    }
    return analysis
  }

  summary() {
    if (this.group == null) throw new Error('Load an Xdebug profile first')
    const datasetId = `dataset-${this.revision}`
    return {
      datasetId,
      filename: this.filename,
      profiles: this.group.profiles.map((_, profileIndex) => ({
        profileIndex,
        ...this.get(datasetId, profileIndex).summary(),
      })),
    }
  }
}
