import {CallTreeNode, Frame, Profile} from './profile'

export enum InvocationSortField {
  TOTAL,
  SELF,
  COUNT,
  CALLER,
  CALL_STACK,
}

export interface InvocationSortMethod {
  field: InvocationSortField
  direction: 'ASCENDING' | 'DESCENDING'
}

export interface InvocationRow {
  node: CallTreeNode
  total: number
  self: number
  callerName: string
  stackNames: string[]
  stackLabel: string
}

export function buildInvocationRow(node: CallTreeNode): InvocationRow {
  const stackNames: string[] = []
  for (let n: CallTreeNode | null = node; n != null && !n.isRoot(); n = n.parent) {
    stackNames.push(n.frame.name)
  }

  const parent = node.parent
  const callerName = parent == null || parent.isRoot() ? '(root)' : parent.frame.name

  return {
    node,
    total: node.getTotalWeight(),
    self: node.getSelfWeight(),
    callerName,
    stackNames,
    stackLabel: stackNames.join(' > '),
  }
}

export function collectInvocationsSync(profile: Profile, frame: Frame): InvocationRow[] {
  const rows: InvocationRow[] = []

  function visit(node: CallTreeNode) {
    if (node.frame === frame) {
      rows.push(buildInvocationRow(node))
    }
    for (const child of node.children) {
      visit(child)
    }
  }

  visit(profile.getAppendOrderCalltreeRoot())
  return rows
}

export interface ChunkedCollectResult {
  rows: InvocationRow[]
  done: boolean
  found: number
  expected: number
}

export interface ChunkedCollector {
  pull(maxMatches: number): ChunkedCollectResult
  cancel(): void
}

export function createChunkedInvocationCollector(
  profile: Profile,
  frame: Frame,
): ChunkedCollector {
  const expected = frame.getCallCount()
  const rows: InvocationRow[] = []
  let cancelled = false
  const stack: {node: CallTreeNode; childIndex: number}[] = [
    {node: profile.getAppendOrderCalltreeRoot(), childIndex: 0},
  ]

  return {
    cancel() {
      cancelled = true
    },
    pull(maxMatches: number): ChunkedCollectResult {
      if (cancelled) {
        return {rows, done: true, found: rows.length, expected}
      }

      let matchesThisChunk = 0
      while (stack.length > 0 && matchesThisChunk < maxMatches) {
        const top = stack[stack.length - 1]
        if (top.childIndex >= top.node.children.length) {
          stack.pop()
          continue
        }

        const child = top.node.children[top.childIndex++]
        if (child.frame === frame) {
          rows.push(buildInvocationRow(child))
          matchesThisChunk++
        }
        if (child.children.length > 0) {
          stack.push({node: child, childIndex: 0})
        }
      }

      return {
        rows,
        done: stack.length === 0,
        found: rows.length,
        expected,
      }
    },
  }
}

export function compareCallStacks(a: string[], b: string[]): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return a.length - b.length
}

export function sortInvocationRows(rows: InvocationRow[], sortMethod: InvocationSortMethod): void {
  const dir = sortMethod.direction === 'DESCENDING' ? -1 : 1

  rows.sort((a, b) => {
    let cmp = 0
    switch (sortMethod.field) {
      case InvocationSortField.TOTAL:
        cmp = a.total < b.total ? -1 : a.total > b.total ? 1 : 0
        break
      case InvocationSortField.SELF:
        cmp = a.self < b.self ? -1 : a.self > b.self ? 1 : 0
        break
      case InvocationSortField.COUNT:
        cmp = 0
        break
      case InvocationSortField.CALLER:
        cmp = a.callerName < b.callerName ? -1 : a.callerName > b.callerName ? 1 : 0
        break
      case InvocationSortField.CALL_STACK:
        cmp = compareCallStacks(a.stackNames, b.stackNames)
        break
    }
    return cmp * dir
  })
}

export interface CallerGroup {
  callerName: string
  total: number
  self: number
  count: number
  invocations: InvocationRow[]
}

export type FlattenedInvocationListRow =
  | {kind: 'group'; group: CallerGroup; isExpanded: boolean}
  | {kind: 'invocation'; row: InvocationRow; indented: boolean}
  | FlattenedStackTreeRow

export function groupInvocationsByCaller(rows: InvocationRow[]): CallerGroup[] {
  const groupsByCaller = new Map<string, CallerGroup>()

  for (const row of rows) {
    let group = groupsByCaller.get(row.callerName)
    if (group == null) {
      group = {
        callerName: row.callerName,
        total: 0,
        self: 0,
        count: 0,
        invocations: [],
      }
      groupsByCaller.set(row.callerName, group)
    }
    group.invocations.push(row)
    group.total += row.total
    group.self += row.self
    group.count += 1
  }

  return Array.from(groupsByCaller.values())
}

export function sortCallerGroups(groups: CallerGroup[], sortMethod: InvocationSortMethod): void {
  for (const group of groups) {
    sortInvocationRows(group.invocations, sortMethod)
  }

  const dir = sortMethod.direction === 'DESCENDING' ? -1 : 1
  groups.sort((a, b) => {
    let cmp = 0
    switch (sortMethod.field) {
      case InvocationSortField.TOTAL:
        cmp = a.total < b.total ? -1 : a.total > b.total ? 1 : 0
        break
      case InvocationSortField.SELF:
        cmp = a.self < b.self ? -1 : a.self > b.self ? 1 : 0
        break
      case InvocationSortField.COUNT:
        cmp = a.count < b.count ? -1 : a.count > b.count ? 1 : 0
        break
      case InvocationSortField.CALLER:
      case InvocationSortField.CALL_STACK:
        cmp = a.callerName < b.callerName ? -1 : a.callerName > b.callerName ? 1 : 0
        break
    }
    if (cmp === 0) {
      cmp = a.callerName < b.callerName ? -1 : a.callerName > b.callerName ? 1 : 0
      return cmp
    }
    return cmp * dir
  })
}

export function flattenCallerGroups(
  groups: CallerGroup[],
  expandedCallers: Set<string>,
): FlattenedInvocationListRow[] {
  const rows: FlattenedInvocationListRow[] = []
  for (const group of groups) {
    const isExpanded = expandedCallers.has(group.callerName)
    rows.push({kind: 'group', group, isExpanded})
    if (isExpanded) {
      for (const invocation of group.invocations) {
        rows.push({kind: 'invocation', row: invocation, indented: true})
      }
    }
  }
  return rows
}

export interface StackTreeNode {
  name: string
  pathKey: string
  depth: number
  total: number
  self: number
  count: number
  callSiteCount: number
  children: StackTreeNode[]
  invocation: InvocationRow | null
}

interface StackTreeBuildNode {
  name: string
  pathKey: string
  depth: number
  total: number
  self: number
  count: number
  children: StackTreeBuildNode[]
  invocation: InvocationRow | null
  childMap: Map<string, StackTreeBuildNode>
  seenCallSites: Set<CallTreeNode>
}

function getRootedCallTreePath(node: CallTreeNode): CallTreeNode[] {
  const chain: CallTreeNode[] = []
  for (let n: CallTreeNode | null = node; n != null && !n.isRoot(); n = n.parent) {
    chain.push(n)
  }
  chain.reverse()
  return chain
}

export function formatStackTreeLabel(node: StackTreeNode): string {
  if (node.invocation != null || node.callSiteCount <= 1) {
    return node.name
  }
  return `${node.name} (${node.callSiteCount.toLocaleString()})`
}

export function buildInvocationStackTree(rows: InvocationRow[]): StackTreeNode[] {
  const roots: StackTreeBuildNode[] = []
  const rootMap: Map<string, StackTreeBuildNode> = new Map()
  let leafId = 0

  for (const row of rows) {
    const callPath = getRootedCallTreePath(row.node)
    if (callPath.length === 0) continue

    let parent: StackTreeBuildNode | null = null

    for (let depth = 0; depth < callPath.length; depth++) {
      const callTreeNode = callPath[depth]
      const name = callTreeNode.frame.name
      const isLeaf = depth === callPath.length - 1

      if (isLeaf) {
        const parentKey = parent ? parent.pathKey : ''
        const leaf: StackTreeBuildNode = {
          name,
          pathKey: `${parentKey}\0leaf:${leafId++}`,
          depth,
          total: row.total,
          self: row.self,
          count: 1,
          children: [],
          invocation: row,
          childMap: new Map(),
          seenCallSites: new Set([callTreeNode]),
        }
        if (parent) {
          parent.children.push(leaf)
        } else {
          roots.push(leaf)
        }
        break
      }

      const pathKey: string = parent ? `${parent.pathKey}\0${name}` : name
      const map: Map<string, StackTreeBuildNode> = parent ? parent.childMap : rootMap
      let node: StackTreeBuildNode | undefined = map.get(name)
      if (node == null) {
        node = {
          name,
          pathKey,
          depth,
          total: 0,
          self: 0,
          count: 0,
          children: [],
          invocation: null,
          childMap: new Map(),
          seenCallSites: new Set(),
        }
        map.set(name, node)
        if (parent) {
          parent.children.push(node)
        } else {
          roots.push(node)
        }
      }
      node.total += row.total
      node.self += row.self
      node.count += 1
      node.seenCallSites.add(callTreeNode)
      parent = node
    }
  }

  function strip(node: StackTreeBuildNode): StackTreeNode {
    return {
      name: node.name,
      pathKey: node.pathKey,
      depth: node.depth,
      total: node.total,
      self: node.self,
      count: node.count,
      callSiteCount: node.seenCallSites.size,
      children: node.children.map(strip),
      invocation: node.invocation,
    }
  }

  return roots.map(strip)
}

export function sortStackTree(nodes: StackTreeNode[], sortMethod: InvocationSortMethod): void {
  const dir = sortMethod.direction === 'DESCENDING' ? -1 : 1

  nodes.sort((a, b) => {
    let cmp = 0
    switch (sortMethod.field) {
      case InvocationSortField.TOTAL:
        cmp = a.total < b.total ? -1 : a.total > b.total ? 1 : 0
        break
      case InvocationSortField.SELF:
        cmp = a.self < b.self ? -1 : a.self > b.self ? 1 : 0
        break
      case InvocationSortField.COUNT:
        cmp = a.count < b.count ? -1 : a.count > b.count ? 1 : 0
        break
      case InvocationSortField.CALLER:
      case InvocationSortField.CALL_STACK:
        cmp = a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        break
    }
    if (cmp === 0) {
      cmp = a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      return cmp
    }
    return cmp * dir
  })

  for (const node of nodes) {
    if (node.children.length > 0) {
      sortStackTree(node.children, sortMethod)
    }
  }
}

export type FlattenedStackTreeRow = {
  kind: 'stack'
  node: StackTreeNode
  isExpanded: boolean
  hasChildren: boolean
}

export function flattenStackTree(
  nodes: StackTreeNode[],
  expandedPathKeys: Set<string>,
): FlattenedStackTreeRow[] {
  const rows: FlattenedStackTreeRow[] = []

  function visit(node: StackTreeNode) {
    const hasChildren = node.children.length > 0
    const isExpanded = hasChildren && expandedPathKeys.has(node.pathKey)
    rows.push({kind: 'stack', node, isExpanded, hasChildren})
    if (isExpanded) {
      for (const child of node.children) {
        visit(child)
      }
    }
  }

  for (const node of nodes) {
    visit(node)
  }
  return rows
}
