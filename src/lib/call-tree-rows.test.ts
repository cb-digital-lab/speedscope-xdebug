import {StackListProfileBuilder, CallTreeNode, FrameInfo} from './profile'
import {buildCallTreeRows, getAllExpandableNodes, getAncestorNodes} from './call-tree-rows'
import {SortDirection, TreeSortField} from '../app-state'

function getFrameInfo(key: string): FrameInfo {
  return {
    key: key,
    name: key,
    file: `${key}.ts`,
    line: key.length,
  }
}

const fa = getFrameInfo('a')
const fb = getFrameInfo('b')
const fc = getFrameInfo('c')
const fd = getFrameInfo('d')
const fe = getFrameInfo('e')

function buildTestProfile() {
  const b = new StackListProfileBuilder()

  const samples = [
    [fa],
    [fa, fb],
    [fa, fb],
    [fa, fb, fd],
    [fa, fb, fc],
    [],
    [fa],
    [fa, fb],
    [fa, fb, fb],
    [fa, fb, fe],
    [fa],
  ]

  samples.forEach(stack => {
    b.appendSampleWithWeight(stack, 1)
  })
  b.appendSampleWithWeight([], 4)

  return b.build()
}

function findNodeByPath(root: CallTreeNode, path: string[]): CallTreeNode | null {
  let node: CallTreeNode = root
  for (let name of path) {
    const child = node.children.find(c => c.frame.name === name)
    if (!child) return null
    node = child
  }
  return node
}

test('buildCallTreeRows shows first level when nothing expanded', () => {
  const profile = buildTestProfile()
  const root = profile.getAppendOrderCalltreeRoot()
  const rows = buildCallTreeRows(root, new Set(), {
    field: TreeSortField.CALL_ORDER,
    direction: SortDirection.ASCENDING,
  })

  expect(rows.length).toBe(root.children.length)
  expect(rows.every(r => r.depth === 0)).toBe(true)
  expect(rows.every(r => r.node.frame.name === 'a')).toBe(true)
})

test('buildCallTreeRows expands children when parent is in expanded set', () => {
  const profile = buildTestProfile()
  const root = profile.getAppendOrderCalltreeRoot()
  const aNode = findNodeByPath(root, ['a'])!

  const rows = buildCallTreeRows(root, new Set([aNode]), {
    field: TreeSortField.CALL_ORDER,
    direction: SortDirection.ASCENDING,
  })
  const names = rows.map(r => r.node.frame.name)

  expect(names[0]).toBe('a')
  expect(names).toContain('b')
  expect(rows.find(r => r.node.frame.name === 'a')!.isExpanded).toBe(true)
})

test('buildCallTreeRows preserves call order by default', () => {
  const profile = buildTestProfile()
  const root = profile.getAppendOrderCalltreeRoot()
  const aNode = findNodeByPath(root, ['a'])!
  const firstBNode = findNodeByPath(root, ['a', 'b'])!

  const rows = buildCallTreeRows(root, new Set([aNode, firstBNode]), {
    field: TreeSortField.CALL_ORDER,
    direction: SortDirection.ASCENDING,
  })
  const bChildRows = rows.filter(
    r => r.depth === 2 && r.node.parent?.frame.name === 'b' && r.node.parent === firstBNode,
  )

  expect(bChildRows.map(r => r.node.frame.name)).toEqual(['d', 'c'])

  const weightSortedRows = buildCallTreeRows(root, new Set([aNode, firstBNode]), {
    field: TreeSortField.TOTAL,
    direction: SortDirection.DESCENDING,
  })
  const weightSortedBChildRows = weightSortedRows.filter(
    r => r.depth === 2 && r.node.parent === firstBNode,
  )
  expect(weightSortedBChildRows.map(r => r.node.frame.name)).not.toEqual(['d', 'c'])
})

test('buildCallTreeRows assigns heat relative to heaviest sibling in scope', () => {
  const profile = buildTestProfile()
  const root = profile.getAppendOrderCalltreeRoot()
  const aNode = findNodeByPath(root, ['a'])!
  const firstBNode = findNodeByPath(root, ['a', 'b'])!

  const rows = buildCallTreeRows(root, new Set([aNode, firstBNode]), {
    field: TreeSortField.TOTAL,
    direction: SortDirection.DESCENDING,
  })

  const bChildRows = rows.filter(r => r.depth === 2 && r.node.parent === firstBNode)

  // The heaviest sibling in a scope is always fully hot (ratio 1).
  const maxHeat = Math.max(...bChildRows.map(r => r.totalHeat))
  expect(maxHeat).toBe(1)

  // Heat ratios track the relative weight ordering within the scope.
  for (let i = 1; i < bChildRows.length; i++) {
    expect(bChildRows[i - 1].totalHeat).toBeGreaterThanOrEqual(bChildRows[i].totalHeat)
    expect(bChildRows[i].totalHeat).toBeGreaterThanOrEqual(0)
    expect(bChildRows[i].totalHeat).toBeLessThanOrEqual(1)
  }
})

test('buildCallTreeRows sorts children by total weight descending', () => {
  const profile = buildTestProfile()
  const root = profile.getAppendOrderCalltreeRoot()
  const aNode = findNodeByPath(root, ['a'])!
  const firstBNode = findNodeByPath(root, ['a', 'b'])!

  const rows = buildCallTreeRows(root, new Set([aNode, firstBNode]), {
    field: TreeSortField.TOTAL,
    direction: SortDirection.DESCENDING,
  })
  const bChildRows = rows.filter(
    r => r.depth === 2 && r.node.parent?.frame.name === 'b' && r.node.parent === firstBNode,
  )

  for (let i = 1; i < bChildRows.length; i++) {
    expect(bChildRows[i - 1].node.getTotalWeight()).toBeGreaterThanOrEqual(
      bChildRows[i].node.getTotalWeight(),
    )
  }
})

test('getAllExpandableNodes includes nodes with children', () => {
  const profile = buildTestProfile()
  const root = profile.getAppendOrderCalltreeRoot()
  const expandable = getAllExpandableNodes(root)
  const aNode = findNodeByPath(root, ['a'])!

  expect(expandable.has(aNode)).toBe(true)
  expect(expandable.has(findNodeByPath(root, ['a', 'b'])!)).toBe(true)
})

test('getAncestorNodes returns parents up to root', () => {
  const profile = buildTestProfile()
  const root = profile.getAppendOrderCalltreeRoot()
  const dNode = findNodeByPath(root, ['a', 'b', 'd'])!

  const ancestors = getAncestorNodes(dNode)
  expect(ancestors.map(n => n.frame.name)).toEqual(['b', 'a'])
})
