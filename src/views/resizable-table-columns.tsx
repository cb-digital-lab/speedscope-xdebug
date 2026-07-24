import {h} from 'preact'
import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks'
import {StyleSheet, css} from 'aphrodite'
import {clamp} from '../lib/math'
import {cachedMeasureTextWidth} from '../lib/text-utils'
import {FontSize} from './style'
import {Theme, useTheme, withTheme} from './themes/theme'

const RESIZE_HANDLE_HIT_WIDTH = 6
const AUTO_SIZE_PADDING = 28
const DEFAULT_MAX_MEASURE_ROWS = 500

let measureCanvas: HTMLCanvasElement | null = null
let measureCtx: CanvasRenderingContext2D | null = null

function getMeasureContext(): CanvasRenderingContext2D {
  if (measureCanvas == null) {
    measureCanvas = document.createElement('canvas')
    measureCtx = measureCanvas.getContext('2d')
  }
  if (measureCtx == null) {
    throw new Error('Failed to create measure context')
  }
  measureCtx.font = `${FontSize.LABEL}px sans-serif`
  return measureCtx
}

function measureText(text: string): number {
  return cachedMeasureTextWidth(getMeasureContext(), text)
}

export interface UseResizableTableColumnsOptions {
  defaultWidths: number[]
  minWidths: number[]
  getHeaderText: (columnIndex: number) => string
  getCellText: (rowIndex: number, columnIndex: number) => string
  rowCount: number
  maxMeasureRows?: number
}

export function useResizableTableColumns({
  defaultWidths,
  minWidths,
  getHeaderText,
  getCellText,
  rowCount,
  maxMeasureRows = DEFAULT_MAX_MEASURE_ROWS,
}: UseResizableTableColumnsOptions) {
  const [columnWidths, setColumnWidths] = useState<number[]>(() => defaultWidths.slice())
  const [draggingColumn, setDraggingColumn] = useState<number | null>(null)
  const dragRef = useRef<{columnIndex: number; startX: number; startWidth: number} | null>(null)
  const suppressClickRef = useRef(false)
  const lastColumnIndex = defaultWidths.length - 1

  useEffect(() => {
    setColumnWidths(prev => {
      if (prev.length === defaultWidths.length) return prev
      return defaultWidths.slice()
    })
  }, [defaultWidths.length])

  const tableMinWidth = useMemo(
    () => columnWidths.reduce((sum, width) => sum + width, 0),
    [columnWidths],
  )

  const endDrag = useCallback(() => {
    dragRef.current = null
    setDraggingColumn(null)
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
  }, [])

  const onMouseMove = useCallback(
    (ev: MouseEvent) => {
      if (dragRef.current == null) return
      const {columnIndex, startX, startWidth} = dragRef.current
      const delta = ev.clientX - startX
      const minWidth = minWidths[columnIndex] ?? 40
      const newWidth = clamp(startWidth + delta, minWidth, 4000)
      setColumnWidths(prev => {
        const next = prev.slice()
        next[columnIndex] = newWidth
        return next
      })
    },
    [minWidths],
  )

  const onMouseUp = useCallback(() => {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    endDrag()
    setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
  }, [endDrag, onMouseMove])

  const startResize = useCallback(
    (columnIndex: number, ev: MouseEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
      suppressClickRef.current = true
      dragRef.current = {
        columnIndex,
        startX: ev.clientX,
        startWidth: columnWidths[columnIndex],
      }
      setDraggingColumn(columnIndex)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [columnWidths, onMouseMove, onMouseUp],
  )

  const consumeClickSuppression = useCallback(() => {
    if (!suppressClickRef.current) return false
    suppressClickRef.current = false
    return true
  }, [])

  const measureColumnWidth = useCallback(
    (columnIndex: number) => {
      let maxWidth = measureText(getHeaderText(columnIndex))
      const rowsToMeasure = Math.min(rowCount, maxMeasureRows)
      for (let rowIndex = 0; rowIndex < rowsToMeasure; rowIndex++) {
        maxWidth = Math.max(maxWidth, measureText(getCellText(rowIndex, columnIndex)))
      }
      const minWidth = minWidths[columnIndex] ?? 40
      return clamp(Math.ceil(maxWidth + AUTO_SIZE_PADDING), minWidth, 4000)
    },
    [getCellText, getHeaderText, maxMeasureRows, minWidths, rowCount],
  )

  const autoSizeColumn = useCallback(
    (columnIndex: number, ev?: MouseEvent) => {
      if (ev) {
        ev.preventDefault()
        ev.stopPropagation()
        suppressClickRef.current = true
      }
      const width = measureColumnWidth(columnIndex)
      setColumnWidths(prev => {
        const next = prev.slice()
        next[columnIndex] = width
        return next
      })
    },
    [measureColumnWidth],
  )

  const autoSizeColumns = useCallback(
    (columnIndices: number[]) => {
      setColumnWidths(prev => {
        const next =
          prev.length === defaultWidths.length ? prev.slice() : defaultWidths.slice()
        for (const columnIndex of columnIndices) {
          if (columnIndex >= 0 && columnIndex < next.length) {
            next[columnIndex] = measureColumnWidth(columnIndex)
          }
        }
        return next
      })
    },
    [measureColumnWidth, defaultWidths],
  )

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      endDrag()
    }
  }, [endDrag, onMouseMove, onMouseUp])

  const renderColGroup = useCallback(
    () => (
      <colgroup>
        {columnWidths.map((width, index) =>
          index === lastColumnIndex ? (
            <col key={index} style={{minWidth: width}} />
          ) : (
            <col key={index} style={{width}} />
          ),
        )}
      </colgroup>
    ),
    [columnWidths, lastColumnIndex],
  )

  return {
    columnWidths,
    tableMinWidth,
    draggingColumn,
    renderColGroup,
    startResize,
    autoSizeColumn,
    autoSizeColumns,
    consumeClickSuppression,
  }
}

const getHandleStyle = withTheme((theme: Theme) =>
  StyleSheet.create({
    resizeHandle: {
      position: 'absolute',
      top: 0,
      right: -RESIZE_HANDLE_HIT_WIDTH / 2,
      width: RESIZE_HANDLE_HIT_WIDTH,
      height: '100%',
      cursor: 'col-resize',
      zIndex: 1,
    },
    resizeHandleActive: {
      background: theme.fgPrimaryColor,
      opacity: 0.35,
    },
  }),
)

interface ColumnResizeHandleProps {
  columnIndex: number
  active: boolean
  onResizeStart: (columnIndex: number, ev: MouseEvent) => void
  onAutoSize: (columnIndex: number, ev: MouseEvent) => void
}

export function ColumnResizeHandle({
  columnIndex,
  active,
  onResizeStart,
  onAutoSize,
}: ColumnResizeHandleProps) {
  const style = getHandleStyle(useTheme())

  const onMouseDown = useCallback(
    (ev: MouseEvent) => onResizeStart(columnIndex, ev),
    [columnIndex, onResizeStart],
  )
  const onDoubleClick = useCallback(
    (ev: MouseEvent) => onAutoSize(columnIndex, ev),
    [columnIndex, onAutoSize],
  )
  const onClick = useCallback((ev: MouseEvent) => {
    ev.preventDefault()
    ev.stopPropagation()
  }, [])

  return (
    <div
      className={css(style.resizeHandle, active && style.resizeHandleActive)}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDblClick={onDoubleClick}
    />
  )
}
