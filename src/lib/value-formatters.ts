import {FileFormat} from './file-format-spec'
import {zeroPad} from './utils'

export interface ValueFormatter {
  unit: FileFormat.ValueUnit
  // Axis labels may need enough decimals to distinguish adjacent gridlines.
  format(v: number, resolution?: number): string
}

function decimalPlaces(resolution: number | undefined, minimum: number) {
  return resolution != null && resolution > 0 && Number.isFinite(resolution)
    ? Math.min(12, Math.max(minimum, Math.ceil(-Math.log10(resolution))))
    : minimum
}

export class RawValueFormatter implements ValueFormatter {
  unit: FileFormat.ValueUnit = 'none'
  format(v: number, resolution?: number) {
    return v.toLocaleString(undefined, {maximumFractionDigits: decimalPlaces(resolution, 3)})
  }
}

export class TimeFormatter implements ValueFormatter {
  private multiplier: number

  constructor(public unit: 'nanoseconds' | 'microseconds' | 'milliseconds' | 'seconds') {
    if (unit === 'nanoseconds') this.multiplier = 1e-9
    else if (unit === 'microseconds') this.multiplier = 1e-6
    else if (unit === 'milliseconds') this.multiplier = 1e-3
    else this.multiplier = 1
  }

  formatUnsigned(v: number, resolution?: number) {
    const s = v * this.multiplier
    const step = resolution == null ? undefined : resolution * this.multiplier

    if (s / 60 >= 1 && (step == null || step >= 1)) {
      const minutes = Math.floor(s / 60)
      const seconds = Math.floor(s - minutes * 60).toString()
      return `${minutes}:${zeroPad(seconds, 2)}`
    }
    const format = (scale: number) =>
      (s / scale).toFixed(decimalPlaces(step == null ? undefined : step / scale, 2))
    if (s / 1 >= 1) return `${format(1)}s`
    if (s / 1e-3 >= 1) return `${format(1e-3)}ms`
    if (s / 1e-6 >= 1) return `${format(1e-6)}µs`
    else return `${format(1e-9)}ns`
  }

  format(v: number, resolution?: number) {
    return `${v < 0 ? '-' : ''}${this.formatUnsigned(Math.abs(v), resolution)}`
  }
}

export class ByteFormatter implements ValueFormatter {
  unit: FileFormat.ValueUnit = 'bytes'

  format(v: number, resolution?: number) {
    const format = (scale: number, minimum: number) =>
      (v / scale).toFixed(
        decimalPlaces(resolution == null ? undefined : resolution / scale, minimum),
      )
    if (v < 1024) return `${format(1, 0)} B`
    if (v < Math.pow(1024, 2)) return `${format(1024, 2)} KB`
    if (v < Math.pow(1024, 3)) return `${format(Math.pow(1024, 2), 2)} MB`
    return `${format(Math.pow(1024, 3), 2)} GB`
  }
}
