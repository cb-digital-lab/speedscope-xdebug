import {CallTreeProfileBuilder, FrameInfo} from './profile'
import {
  buildInvocationRow,
  collectInvocationsSync,
  compareCallStacks,
  createChunkedInvocationCollector,
  InvocationSortField,
  sortInvocationRows,
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

test('collectInvocationsSync finds every invocation of a frame', () => {
  const profile = buildProfile()
  let fnFrame: any = null
  profile.forEachFrame(f => {
    if (f.name === 'function 1') fnFrame = f
  })
  expect(fnFrame).not.toBeNull()
  expect(fnFrame.getCallCount()).toBe(6)

  const rows = collectInvocationsSync(profile, fnFrame)
  expect(rows.length).toBe(6)
  expect(rows.every(r => r.node.frame === fnFrame)).toBe(true)
})

test('buildInvocationRow shapes caller and reverse call stack', () => {
  const profile = buildProfile()
  let fnFrame: any = null
  profile.forEachFrame(f => {
    if (f.name === 'function 1') fnFrame = f
  })
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
  let fnFrame: any = null
  profile.forEachFrame(f => {
    if (f.name === 'function 1') fnFrame = f
  })
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
  let fnFrame: any = null
  profile.forEachFrame(f => {
    if (f.name === 'function 1') fnFrame = f
  })
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
  let fnFrame: any = null
  profile.forEachFrame(f => {
    if (f.name === 'function 1') fnFrame = f
  })

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
