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
