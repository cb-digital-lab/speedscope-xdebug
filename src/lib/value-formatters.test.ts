import {TimeFormatter, ByteFormatter, ValueFormatter} from './value-formatters'

describe('TimeFormatter', () => {
  test('input units milliseconds', () => {
    const f = new TimeFormatter('milliseconds')
    expect(f.format(0.00004)).toEqual('40.00ns')
    expect(f.format(0.04)).toEqual('40.00µs')
    expect(f.format(3)).toEqual('3.00ms')
    expect(f.format(2070)).toEqual('2.07s')
    expect(f.format(150000)).toEqual('2:30')
    expect(f.format(1203123)).toEqual('20:03')
  })

  test('input units seconds', () => {
    const f = new TimeFormatter('seconds')
    expect(f.format(0.00004)).toEqual('40.00µs')
    expect(f.format(0.003)).toEqual('3.00ms')
    expect(f.format(2.07)).toEqual('2.07s')
    expect(f.format(150)).toEqual('2:30')
    expect(f.format(1203.123)).toEqual('20:03')
  })

  test('axis labels distinguish microsecond intervals late in a profile', () => {
    const f: ValueFormatter = new TimeFormatter('nanoseconds')
    expect(f.format(6400000000, 500)).toEqual('6.4000000s')
    expect(f.format(6400000500, 500)).toEqual('6.4000005s')
  })

  test('axis labels retain subsecond precision beyond one minute', () => {
    const f: ValueFormatter = new TimeFormatter('seconds')
    expect(f.format(150.001, 0.001)).toEqual('150.001s')
    expect(f.format(150, 1)).toEqual('2:30')
  })
})

test('ByteFormatter', () => {
  const f = new ByteFormatter()
  expect(f.format(100)).toEqual('100 B')
  expect(f.format(1024)).toEqual('1.00 KB')
  expect(f.format(3.5 * 1024 * 1024)).toEqual('3.50 MB')
  expect(f.format(4.32 * 1024 * 1024 * 1024)).toEqual('4.32 GB')
})

test('memory axis labels distinguish byte intervals at megabyte offsets', () => {
  const f: ValueFormatter = new ByteFormatter()
  expect(f.format(100 * 1024 * 1024 + 1, 1)).toEqual('100.0000010 MB')
  expect(f.format(100 * 1024 * 1024 + 2, 1)).toEqual('100.0000019 MB')
})
