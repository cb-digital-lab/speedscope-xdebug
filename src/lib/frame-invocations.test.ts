import {CallTreeProfileBuilder, FrameInfo} from './profile'
import {
  buildInvocationRow,
  collectInvocationsSync,
  compareCallStacks,
  createChunkedInvocationCollector,
  flattenCallerGroups,
  flattenStackTree,
  buildInvocationStackTree,
  formatStackTreeLabel,
  groupInvocationsByCaller,
  InvocationSortField,
  sortCallerGroups,
  sortInvocationRows,
  sortStackTree,
} from './frame-invocations'

function frameInfo(key: string): FrameInfo {
  return {key, name: key}
}

function buildProfile() {
  const b = new CallTreeProfileBuilder()
  const main = frameInfo('main')
  const parent1 = frameInfo('parent 1')
  const parent11 = frameInfo('parent 1.1')
  const parent2 = frameInfo('parent 2')
  const otherParent = frameInfo('other parent')
  const yetAnother = frameInfo('yet another parent')
  const fn = frameInfo('function 1')

  b.enterFrame(main, 0)
  b.enterFrame(parent1, 0)
  b.enterFrame(parent11, 0)
  b.enterFrame(fn, 0)
  b.leaveFrame(fn, 100)
  b.leaveFrame(parent11, 100)
  b.leaveFrame(parent1, 100)

  b.enterFrame(otherParent, 100)
  b.enterFrame(fn, 100)
  b.leaveFrame(fn, 130)
  b.leaveFrame(otherParent, 130)

  b.enterFrame(parent1, 130)
  b.enterFrame(parent11, 130)
  b.enterFrame(fn, 130)
  b.leaveFrame(fn, 250)
  b.leaveFrame(parent11, 250)
  b.leaveFrame(parent1, 250)

  b.enterFrame(parent2, 250)
  b.enterFrame(parent11, 250)
  b.enterFrame(fn, 250)
  b.leaveFrame(fn, 400)
  b.leaveFrame(parent11, 400)
  b.leaveFrame(parent2, 400)

  b.enterFrame(parent2, 400)
  b.enterFrame(parent11, 400)
  b.enterFrame(fn, 400)
  b.leaveFrame(fn, 600)
  b.leaveFrame(parent11, 600)
  b.leaveFrame(parent2, 600)

  b.enterFrame(yetAnother, 600)
  b.enterFrame(parent2, 600)
  b.enterFrame(parent11, 600)
  b.enterFrame(fn, 600)
  b.leaveFrame(fn, 800)
  b.leaveFrame(parent11, 800)
  b.leaveFrame(parent2, 800)
  b.leaveFrame(yetAnother, 800)

  b.leaveFrame(main, 800)
  return b.build()
}

function getFnFrame(profile: ReturnType<typeof buildProfile>) {
  let fnFrame: any = null
  profile.forEachFrame(f => {
    if (f.name === 'function 1') fnFrame = f
  })
  return fnFrame
}

test('collectInvocationsSync finds every invocation of a frame', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)
  expect(fnFrame).not.toBeNull()
  expect(fnFrame.getCallCount()).toBe(6)

  const rows = collectInvocationsSync(profile, fnFrame)
  expect(rows.length).toBe(6)
  expect(rows.every(r => r.node.frame === fnFrame)).toBe(true)
})

test('buildInvocationRow shapes caller and reverse call stack', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)
  const rows = collectInvocationsSync(profile, fnFrame)
  const first = rows[0]

  expect(first.callerName).toBe('parent 1.1')
  expect(first.stackNames[0]).toBe('function 1')
  expect(first.stackLabel).toContain('function 1 > parent 1.1')
  expect(first.stackLabel.endsWith('main')).toBe(true)
})

test('compareCallStacks is lexicographic with shorter prefix first', () => {
  expect(
    compareCallStacks(
      ['function 1', 'parent 1.1', 'parent 2', 'main'],
      ['function 1', 'parent 1.1', 'parent 2', 'yet another parent', 'main'],
    ),
  ).toBeLessThan(0)

  expect(
    compareCallStacks(
      ['function 1', 'other parent', 'main'],
      ['function 1', 'parent 1.1', 'parent 1', 'main'],
    ),
  ).toBeLessThan(0)
})

test('sortInvocationRows by call stack groups shared prefixes', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)
  const rows = collectInvocationsSync(profile, fnFrame)
  sortInvocationRows(rows, {
    field: InvocationSortField.CALL_STACK,
    direction: 'ASCENDING',
  })

  const labels = rows.map(r => r.stackLabel)
  expect(labels[0]).toContain('other parent')
  for (let i = 1; i < labels.length; i++) {
    expect(compareCallStacks(rows[i - 1].stackNames, rows[i].stackNames)).toBeLessThanOrEqual(0)
  }
})

test('sortInvocationRows by total descending', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)
  const rows = collectInvocationsSync(profile, fnFrame)
  sortInvocationRows(rows, {
    field: InvocationSortField.TOTAL,
    direction: 'DESCENDING',
  })

  for (let i = 1; i < rows.length; i++) {
    expect(rows[i - 1].total).toBeGreaterThanOrEqual(rows[i].total)
  }
})

test('chunked collector eventually finds all invocations', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)

  const collector = createChunkedInvocationCollector(profile, fnFrame)
  let result = collector.pull(2)
  expect(result.done).toBe(false)
  expect(result.found).toBe(2)
  expect(result.expected).toBe(6)

  while (!result.done) {
    result = collector.pull(2)
  }
  expect(result.found).toBe(6)
  expect(result.rows.length).toBe(6)
})

test('buildInvocationRow uses (root) when parent is the profile root', () => {
  const b = new CallTreeProfileBuilder()
  const main = frameInfo('main')
  b.enterFrame(main, 0)
  b.leaveFrame(main, 10)
  const profile = b.build()
  let mainFrame: any = null
  profile.forEachFrame(f => {
    if (f.name === 'main') mainFrame = f
  })
  const row = buildInvocationRow(collectInvocationsSync(profile, mainFrame)[0].node)
  expect(row.callerName).toBe('(root)')
})

test('groupInvocationsByCaller aggregates totals and keeps children', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)
  const rows = collectInvocationsSync(profile, fnFrame)
  const groups = groupInvocationsByCaller(rows)

  const byCaller = new Map(groups.map(g => [g.callerName, g]))
  expect(byCaller.size).toBe(2)
  expect(byCaller.get('parent 1.1')!.invocations.length).toBe(5)
  expect(byCaller.get('other parent')!.invocations.length).toBe(1)

  const parent11 = byCaller.get('parent 1.1')!
  expect(parent11.count).toBe(5)
  expect(parent11.total).toBe(parent11.invocations.reduce((sum, r) => sum + r.total, 0))
  expect(parent11.self).toBe(parent11.invocations.reduce((sum, r) => sum + r.self, 0))
})

test('sortCallerGroups sorts groups and children by total descending', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)
  const groups = groupInvocationsByCaller(collectInvocationsSync(profile, fnFrame))
  sortCallerGroups(groups, {
    field: InvocationSortField.TOTAL,
    direction: 'DESCENDING',
  })

  for (let i = 1; i < groups.length; i++) {
    expect(groups[i - 1].total).toBeGreaterThanOrEqual(groups[i].total)
  }
  for (const group of groups) {
    for (let i = 1; i < group.invocations.length; i++) {
      expect(group.invocations[i - 1].total).toBeGreaterThanOrEqual(group.invocations[i].total)
    }
  }
})

test('sortCallerGroups by count descending', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)
  const groups = groupInvocationsByCaller(collectInvocationsSync(profile, fnFrame))
  sortCallerGroups(groups, {
    field: InvocationSortField.COUNT,
    direction: 'DESCENDING',
  })

  expect(groups[0].callerName).toBe('parent 1.1')
  expect(groups[0].count).toBe(5)
  expect(groups[1].callerName).toBe('other parent')
  expect(groups[1].count).toBe(1)
})

test('flattenCallerGroups expands only selected callers', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)
  const groups = groupInvocationsByCaller(collectInvocationsSync(profile, fnFrame))
  sortCallerGroups(groups, {
    field: InvocationSortField.CALLER,
    direction: 'ASCENDING',
  })

  const collapsed = flattenCallerGroups(groups, new Set())
  expect(collapsed.every(r => r.kind === 'group')).toBe(true)
  expect(collapsed.length).toBe(groups.length)

  const expandedName = groups[0].callerName
  const expanded = flattenCallerGroups(groups, new Set([expandedName]))
  expect(expanded[0]).toMatchObject({kind: 'group', isExpanded: true})
  expect(
    expanded.slice(1, 1 + groups[0].invocations.length).every(r => r.kind === 'invocation'),
  ).toBe(true)
  expect(expanded.length).toBe(groups.length + groups[0].invocations.length)
})

test('buildInvocationStackTree is rooted and aggregates along paths', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)
  const tree = buildInvocationStackTree(collectInvocationsSync(profile, fnFrame))

  expect(tree.length).toBe(1)
  expect(tree[0].name).toBe('main')
  expect(tree[0].count).toBe(6)
  expect(tree[0].callSiteCount).toBe(1)
  expect(tree[0].invocation).toBeNull()

  const byName = new Map(tree[0].children.map(c => [c.name, c]))
  expect(byName.get('parent 1')!.count).toBe(2)
  expect(byName.get('parent 1')!.callSiteCount).toBe(2)
  expect(byName.get('other parent')!.count).toBe(1)
  expect(byName.get('other parent')!.callSiteCount).toBe(1)
  expect(byName.get('parent 2')!.count).toBe(2)
  expect(byName.get('parent 2')!.callSiteCount).toBe(2)
  expect(byName.get('yet another parent')!.count).toBe(1)

  const leafCount = (node: ReturnType<typeof buildInvocationStackTree>[0]): number => {
    if (node.invocation) return 1
    return node.children.reduce((sum, child) => sum + leafCount(child), 0)
  }
  expect(leafCount(tree[0])).toBe(6)
})

test('formatStackTreeLabel shows call-site count when a branch is merged', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)
  const tree = buildInvocationStackTree(collectInvocationsSync(profile, fnFrame))
  const parent1 = tree[0].children.find(c => c.name === 'parent 1')!
  expect(formatStackTreeLabel(parent1)).toBe('parent 1 (2)')
  expect(formatStackTreeLabel(tree[0])).toBe('main')
})

test('flattenStackTree expands nested paths', () => {
  const profile = buildProfile()
  const fnFrame = getFnFrame(profile)
  const tree = buildInvocationStackTree(collectInvocationsSync(profile, fnFrame))
  sortStackTree(tree, {field: InvocationSortField.COUNT, direction: 'DESCENDING'})

  const collapsed = flattenStackTree(tree, new Set())
  expect(collapsed.length).toBe(1)
  expect(collapsed[0].node.name).toBe('main')
  expect(collapsed[0].hasChildren).toBe(true)
  expect(collapsed[0].isExpanded).toBe(false)

  const expanded = flattenStackTree(tree, new Set([tree[0].pathKey]))
  expect(expanded.length).toBe(1 + tree[0].children.length)
  expect(expanded[0].isExpanded).toBe(true)
})
