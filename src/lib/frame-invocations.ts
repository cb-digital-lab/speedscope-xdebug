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
