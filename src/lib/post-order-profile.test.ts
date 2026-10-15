import {CallTreeNode, CallTreeProfileBuilder, Profile} from './profile'
import {PostOrderCallTreeProfileBuilder} from './post-order-profile'

function describeProfile(profile: Profile) {
  const frames: unknown[] = []
  profile.forEachFrame(frame =>
    frames.push([frame.key, frame.getSelfWeight(), frame.getTotalWeight(), frame.getCallCount()]),
  )
  const tree = (node: CallTreeNode): unknown => [
    node.frame.key,
    node.getStartValue(),
    node.getSelfWeight(),
    node.getTotalWeight(),
    node.isFrozen(),
    node.children.map(tree),
  ]
  const calls: unknown[] = []
  profile.forEachCall(
    (node, value) => calls.push(['open', node.frame.key, value]),
    (node, value) => calls.push(['close', node.frame.key, value]),
  )
  return {
    frames,
    calls,
    append: tree(profile.getAppendOrderCalltreeRoot()),
    grouped: tree(profile.getGroupedCalltreeRoot()),
    total: profile.getTotalWeight(),
    nonIdle: profile.getTotalNonIdleWeight(),
    depth: profile.getMaxStackDepth(),
  }
}

test('post-order construction preserves trees, samples and recursive frame totals', () => {
  const reference = new CallTreeProfileBuilder()
  const builder = new PostOrderCallTreeProfileBuilder()
  const frames = ['a', 'b', 'c'].map(key => ({key, name: key}))
  let cumulative = 0
  let seed = 42
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const emit = (depth: number) => {
    const frame = frames[next() % frames.length]
    reference.enterFrame(frame, Math.round(cumulative * 10))
    builder.enterFrame(frame)
    if (depth > 0) {
      const count = next() % 5
      for (let i = 0; i < count; i++) emit(depth - 1)
    }
    cumulative += Math.max(0, (next() % 10) - 3) / 4
    reference.leaveFrame(frame, Math.round(cumulative * 10))
    builder.leaveFrame(Math.round(cumulative * 10))
  }
  for (let i = 0; i < 20; i++) emit(5)
  expect(describeProfile(builder.build())).toEqual(describeProfile(reference.build()))
})

test('post-order construction rejects unfinished calls and decreasing costs', () => {
  const builder = new PostOrderCallTreeProfileBuilder()
  builder.enterFrame({key: 'a', name: 'a'})
  expect(() => builder.build()).toThrow('non-empty stack')
  expect(() => builder.leaveFrame(-1)).toThrow('increasing')
})
