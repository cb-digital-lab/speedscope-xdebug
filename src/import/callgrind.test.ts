import {checkProfileSnapshot} from '../lib/test-utils'

test('importFromCallgrind', async () => {
  await checkProfileSnapshot('./sample/profiles/callgrind/callgrind.example.log')
})

test('importFromCallgrind name compression', async () => {
  await checkProfileSnapshot('./sample/profiles/callgrind/callgrind.name-compression.log')
})

test('importFromCallgrind multiple event types', async () => {
  await checkProfileSnapshot('./sample/profiles/callgrind/callgrind.multiple-event-types.log')
})

test('importFromCallgrind subposition compression', async () => {
  await checkProfileSnapshot('./sample/profiles/callgrind/callgrind.subposition-compression.log')
})

test('importFromCallgrind cfn reset', async () => {
  await checkProfileSnapshot('./sample/profiles/callgrind/callgrind.cfn-reset.log')
})

test('importFromCallgrind xdebug per-invocation context', async () => {
  await checkProfileSnapshot('./sample/profiles/callgrind/callgrind.xdebug-context.log')
})

test('importFromCallgrind reconstruction with inconsistent costs', async () => {
  await checkProfileSnapshot('./sample/profiles/callgrind/callgrind.inconsistent-costs.log')
})
