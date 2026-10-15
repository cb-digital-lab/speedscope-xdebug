import {checkProfileSnapshot} from '../lib/test-utils'
import {importFromCallgrind} from './callgrind'
import {
  BufferBackedTextFileContent,
  StringBackedTextFileContent,
  withMockedFileChunkSizeForTests,
} from './utils'

test('importFromCallgrind xdebug per-invocation context', async () => {
  await checkProfileSnapshot('./sample/profiles/callgrind/callgrind.xdebug-context.log')
})

test('importFromCallgrind reconstruction with inconsistent costs', async () => {
  await checkProfileSnapshot('./sample/profiles/callgrind/callgrind.inconsistent-costs.log')
})

const profile = `version: 1
creator: xdebug 3.5.0
positions: line
events: Time_(10ns) Memory_(bytes)
fl=(1) index.php
fn=(1) main
fn=(2) child
fn=(2)
1 3 20
fn=(1)
1 5 10
cfn=(2)
calls=1 1
1 3 20
`

test('forces post-order reconstruction even with unique functions and name declarations', () => {
  const group = importFromCallgrind(new StringBackedTextFileContent(profile), 'test')!
  expect(group.profiles).toHaveLength(2)
  const time = group.profiles[0]
  expect(time.isTimelineReconstructed()).toBe(true)
  expect(time.getTotalWeight()).toBe(80)
  const roots = time.getAppendOrderCalltreeRoot().children
  expect(roots.map(node => node.frame.name)).toEqual(['main'])
  expect(roots[0].children.map(node => node.frame.name)).toEqual(['child'])
  expect(roots[0].frame.getCallCount()).toBe(1)
  expect(roots[0].children[0].getStartValue()).toBe(0)
  expect(group.profiles[1].getTotalWeight()).toBe(30)
})

test('rejects a caller whose completed children are missing', () => {
  const invalid = profile.replace('calls=1 1', 'calls=2 1')
  expect(() => importFromCallgrind(new StringBackedTextFileContent(invalid), 'test')).toThrow(
    'missing child records',
  )
})

test('rejects other declared producers rather than guessing a call graph', () => {
  expect(() =>
    importFromCallgrind(
      new StringBackedTextFileContent(profile.replace('xdebug 3.5.0', 'valgrind')),
      'test',
    ),
  ).toThrow('Xdebug')
})

test('line streaming preserves unicode, empty lines and chunk boundaries', async () => {
  const text = 'é\n\nlong line across chunks\nlast\n'
  const bytes = new TextEncoder().encode(text)
  await withMockedFileChunkSizeForTests(3, async () => {
    const contents = new BufferBackedTextFileContent(bytes.buffer as ArrayBuffer)
    expect(Array.from(contents.splitLines())).toEqual(text.split('\n'))
  })
})

test('reconstructs siblings across compact record chunks for both metrics', () => {
  const count = (1 << 16) + 1
  const input = `events: Time_(10ns) Memory_(bytes)
fl=large.php
fn=(1) child
1 1 2
${'fn=(1)\n1 1 2\n'.repeat(count - 1)}fn=parent
1 3 4
cfn=(1)
calls=${count} 1
1 ${count} ${count * 2}
`
  const group = importFromCallgrind(new StringBackedTextFileContent(input), 'large')!
  for (const [index, metric] of group.profiles.entries()) {
    const parent = metric.getAppendOrderCalltreeRoot().children[0]
    const multiplier = index === 0 ? 10 : 2
    expect(parent.children).toHaveLength(count)
    expect(parent.children[0].getStartValue()).toBe(0)
    expect(parent.children[count - 1].getStartValue()).toBe((count - 1) * multiplier)
    expect(parent.children[count - 1].parent).toBe(parent)
    expect(parent.children[0].frame.getCallCount()).toBe(count)
    expect(metric.getTotalWeight()).toBe(index === 0 ? (count + 3) * 10 : count * 2 + 4)
  }
})

test('mixed decimal and compressed costs retain the previous cost line', () => {
  const input = `events: Time_(10ns) Memory_(bytes)
fl=x
fn=main
1 10 20
* * *
2  3  4
* * *
3 5 6
* -1 -2
`
  const group = importFromCallgrind(new StringBackedTextFileContent(input), 'mixed')!
  expect(group.profiles.map(metric => metric.getTotalWeight())).toEqual([350, 58])
})
