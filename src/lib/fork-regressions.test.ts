import {CallTreeProfileBuilder, Frame, FrameInfo} from './profile'
import {forEachCallWithLOD, getFlamechartLODParams} from './flamechart-lod'
import {Rect, Vec2} from './math'
import {
  collectInvocationsSync,
  createChunkedInvocationCollector,
  groupInvocationsByCaller,
  buildInvocationStackTree,
} from './frame-invocations'

function getFrame(profile: ReturnType<CallTreeProfileBuilder['build']>, key: string): Frame {
  let result: Frame | undefined
  profile.forEachFrame(frame => {
    if (frame.key === key) result = frame
  })
  return result!
}

test('LOD preserves the recorded positions, parent self work, and idle gaps', () => {
  const builder = new CallTreeProfileBuilder()
  const a = {key: 'a', name: 'A'}
  const b = {key: 'b', name: 'B'}
  builder.enterFrame(a, 10)
  builder.enterFrame(b, 15)
  builder.leaveFrame(b, 20)
  builder.leaveFrame(a, 30)
  builder.enterFrame(a, 40)
  builder.leaveFrame(a, 50)
  const profile = builder.build()
  const original: any[] = []
  const filtered: any[] = []
  profile.forEachCall(
    (n, v) => original.push(['open', n.frame.name, v]),
    (n, v) => original.push(['close', n.frame.name, v]),
  )
  forEachCallWithLOD(
    profile.getAppendOrderCalltreeRoot(),
    {minFrameWidth: 0, viewLeft: 0, viewRight: 50, quantizedViewportWidth: 50},
    (n, v) => filtered.push(['open', n.frame.name, v]),
    (n, v) => filtered.push(['close', n.frame.name, v]),
  )
  expect(filtered).toEqual(original)
})

test('LOD continues refining at a zoom greater than 1024', () => {
  const params = getFlamechartLODParams(100_000_000, new Rect(Vec2.zero, new Vec2(1, 1)))
  expect(params.minFrameWidth).toBeLessThan(1)
})

test('caller groups and stack branches preserve different functions with identical names', () => {
  const builder = new CallTreeProfileBuilder()
  const main: FrameInfo = {key: 'main', name: 'main'}
  const fn: FrameInfo = {key: 'fn', name: 'fn'}
  const p1: FrameInfo = {key: 'p1', name: 'caller', file: 'plugin-a.php'}
  const p2: FrameInfo = {key: 'p2', name: 'caller', file: 'plugin-b.php'}
  builder.enterFrame(main, 0)
  builder.enterFrame(p1, 0)
  builder.enterFrame(fn, 0)
  builder.leaveFrame(fn, 5)
  builder.leaveFrame(p1, 5)
  builder.enterFrame(p2, 5)
  builder.enterFrame(fn, 5)
  builder.leaveFrame(fn, 15)
  builder.leaveFrame(p2, 15)
  builder.leaveFrame(main, 15)
  const profile = builder.build()
  const rows = collectInvocationsSync(profile, getFrame(profile, 'fn'))
  expect(groupInvocationsByCaller(rows)).toHaveLength(2)
  expect(buildInvocationStackTree(rows)[0].children).toHaveLength(2)
})

test('flattened recursion counts the occurrences in the displayed tree', () => {
  const builder = new CallTreeProfileBuilder()
  const fn: FrameInfo = {key: 'fn', name: 'fn'}
  builder.enterFrame(fn, 0)
  builder.enterFrame(fn, 1)
  builder.leaveFrame(fn, 2)
  builder.leaveFrame(fn, 3)
  const profile = builder.build().getProfileWithRecursionFlattened()
  const frame = getFrame(profile, 'fn')
  const rows = collectInvocationsSync(profile, frame)
  expect(frame.getCallCount()).toBe(rows.length)
})

test('a collector chunk bounds visited nodes even when the matching function is rare', () => {
  const builder = new CallTreeProfileBuilder()
  const ordinary = {key: 'ordinary', name: 'ordinary'}
  const rare = {key: 'rare', name: 'rare'}
  for (let i = 0; i < 10_000; i++) {
    builder.enterFrame(ordinary, i)
    builder.leaveFrame(ordinary, i + 1)
  }
  builder.enterFrame(rare, 10_000)
  builder.leaveFrame(rare, 10_001)
  const profile = builder.build()
  const collector = createChunkedInvocationCollector(profile, getFrame(profile, 'rare'))
  const result = collector.pull(1)
  expect(result.done).toBe(false)
  expect(result.found).toBe(0)
  let next = result
  while (!next.done) next = collector.pull(1)
  expect(next.found).toBe(1)
})
