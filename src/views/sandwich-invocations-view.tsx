import {h, JSX} from 'preact'
import {StyleSheet, css} from 'aphrodite'
import {memo} from 'preact/compat'
import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks'
import {Frame, Profile, CallTreeNode} from '../lib/profile'
import {formatPercent} from '../lib/utils'
import {
  ChunkedCollector,
  createChunkedInvocationCollector,
  InvocationRow,
  InvocationSortField,
  InvocationSortMethod,
  sortInvocationRows,
} from '../lib/frame-invocations'
import {SortDirection, profileGroupAtom, viewModeAtom} from '../app-state'
import {ViewMode} from '../lib/view-mode'
import {ListItem, ScrollableListView} from './scrollable-list-view'
import {FontSize, Sizes, commonStyle} from './style'
import {Color} from '../lib/color'
import {useTheme, withTheme} from './themes/theme'
import {ColumnResizeHandle, useResizableTableColumns} from './resizable-table-columns'

const CHUNK_SIZE = 3000
const REM = 16
const DEFAULT_COLUMN_WIDTHS = [3 * REM, 3 * REM, 10 * REM, 12 * REM]
const MIN_COLUMN_WIDTHS = [2 * REM, 2 * REM, 3 * REM, 3 * REM]

const DEFAULT_SORT: InvocationSortMethod = {
  field: InvocationSortField.TOTAL,
  direction: 'DESCENDING',
}

interface SortIconProps {
  activeDirection: SortDirection | null
}

function SortIcon(props: SortIconProps) {
  const theme = useTheme()
  const style = getStyle(theme)
  const {activeDirection} = props
  const upFill =
    activeDirection === SortDirection.ASCENDING ? theme.fgPrimaryColor : theme.fgSecondaryColor
  const downFill =
    activeDirection === SortDirection.DESCENDING ? theme.fgPrimaryColor : theme.fgSecondaryColor

  return (
    <svg
      width="8"
      height="10"
      viewBox="0 0 8 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={css(style.sortIcon)}
    >
      <path d="M0 4L4 0L8 4H0Z" fill={upFill} />
      <path d="M0 4L4 0L8 4H0Z" transform="translate(0 10) scale(1 -1)" fill={downFill} />
    </svg>
  )
}

function toSortDirection(direction: 'ASCENDING' | 'DESCENDING'): SortDirection {
  return direction === 'ASCENDING' ? SortDirection.ASCENDING : SortDirection.DESCENDING
}

interface HBarProps {
  perc: number
}

function HBarDisplay(props: HBarProps) {
  const style = getStyle(useTheme())
  return (
    <div className={css(style.hBarDisplay)}>
      <div className={css(style.hBarDisplayFilled)} style={{width: `${props.perc}%`}} />
    </div>
  )
}

interface SandwichInvocationsViewProps {
  profile: Profile
  selectedFrame: Frame
}

export const SandwichInvocationsView = memo(
  ({profile, selectedFrame}: SandwichInvocationsViewProps) => {
    const style = getStyle(useTheme())
    const [rows, setRows] = useState<InvocationRow[]>([])
    const [found, setFound] = useState(0)
    const [expected, setExpected] = useState(0)
    const [done, setDone] = useState(false)
    const [sortMethod, setSortMethod] = useState<InvocationSortMethod>(DEFAULT_SORT)
    const [selectedNode, setSelectedNode] = useState<InvocationRow['node'] | null>(null)
    const [scrollLeft, setScrollLeft] = useState(0)
    const collectorRef = useRef<ChunkedCollector | null>(null)
    const rafRef = useRef<number | null>(null)

    useEffect(() => {
      if (collectorRef.current) {
        collectorRef.current.cancel()
        collectorRef.current = null
      }
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }

      setRows([])
      setFound(0)
      setExpected(selectedFrame.getCallCount())
      setDone(false)
      setSortMethod(DEFAULT_SORT)
      setSelectedNode(null)

      const collector = createChunkedInvocationCollector(profile, selectedFrame)
      collectorRef.current = collector

      const tick = () => {
        if (collectorRef.current !== collector) return
        const result = collector.pull(CHUNK_SIZE)
        setFound(result.found)
        setExpected(result.expected)
        if (result.done) {
          const sorted = result.rows.slice()
          sortInvocationRows(sorted, DEFAULT_SORT)
          setRows(sorted)
          setDone(true)
          collectorRef.current = null
          rafRef.current = null
          return
        }
        setRows(result.rows.slice())
        rafRef.current = requestAnimationFrame(tick)
      }

      rafRef.current = requestAnimationFrame(tick)

      return () => {
        collector.cancel()
        if (collectorRef.current === collector) {
          collectorRef.current = null
        }
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current)
          rafRef.current = null
        }
      }
    }, [profile, selectedFrame])

    useEffect(() => {
      if (!done) return
      setRows(prev => {
        const next = prev.slice()
        sortInvocationRows(next, sortMethod)
        return next
      })
    }, [sortMethod, done])

    const onSortClick = useCallback(
      (field: InvocationSortField, ev: MouseEvent) => {
        ev.preventDefault()
        if (!done) return

        setSortMethod(prev => {
          if (prev.field === field) {
            return {
              field,
              direction: prev.direction === 'ASCENDING' ? 'DESCENDING' : 'ASCENDING',
            }
          }
          switch (field) {
            case InvocationSortField.CALLER:
            case InvocationSortField.CALL_STACK:
              return {field, direction: 'ASCENDING'}
            case InvocationSortField.TOTAL:
            case InvocationSortField.SELF:
              return {field, direction: 'DESCENDING'}
          }
        })
      },
      [done],
    )

    const grandTotal = profile.getTotalNonIdleWeight()

    const getHeaderText = useCallback((columnIndex: number) => {
      switch (columnIndex) {
        case 0:
          return 'Total'
        case 1:
          return 'Self'
        case 2:
          return 'Caller'
        case 3:
          return 'Call stack'
        default:
          return ''
      }
    }, [])

    const getCellText = useCallback(
      (rowIndex: number, columnIndex: number) => {
        const row = rows[rowIndex]
        if (!row) return ''
        switch (columnIndex) {
          case 0: {
            const totalPerc = grandTotal === 0 ? 0 : (100.0 * row.total) / grandTotal
            return `${profile.formatValue(row.total)} (${formatPercent(totalPerc)})`
          }
          case 1: {
            const selfPerc = grandTotal === 0 ? 0 : (100.0 * row.self) / grandTotal
            return `${profile.formatValue(row.self)} (${formatPercent(selfPerc)})`
          }
          case 2:
            return row.callerName
          case 3:
            return row.stackLabel
          default:
            return ''
        }
      },
      [rows, grandTotal, profile],
    )

    const {
      tableMinWidth,
      draggingColumn,
      renderColGroup,
      startResize,
      autoSizeColumn,
      autoSizeColumns,
      consumeClickSuppression,
    } = useResizableTableColumns({
      defaultWidths: DEFAULT_COLUMN_WIDTHS,
      minWidths: MIN_COLUMN_WIDTHS,
      getHeaderText,
      getCellText,
      rowCount: rows.length,
    })

    const didAutoSizeRef = useRef(false)
    useEffect(() => {
      didAutoSizeRef.current = false
    }, [selectedFrame])

    useEffect(() => {
      if (!done || rows.length === 0 || didAutoSizeRef.current) return
      didAutoSizeRef.current = true
      autoSizeColumns([0, 1])
    }, [done, rows.length, autoSizeColumns])

    const handleSortClick = useCallback(
      (field: InvocationSortField, ev: MouseEvent) => {
        if (consumeClickSuppression()) {
          ev.preventDefault()
          return
        }
        onSortClick(field, ev)
      },
      [consumeClickSuppression, onSortClick],
    )

    const onTotalClick = useCallback(
      (ev: MouseEvent) => handleSortClick(InvocationSortField.TOTAL, ev),
      [handleSortClick],
    )
    const onSelfClick = useCallback(
      (ev: MouseEvent) => handleSortClick(InvocationSortField.SELF, ev),
      [handleSortClick],
    )
    const onCallerClick = useCallback(
      (ev: MouseEvent) => handleSortClick(InvocationSortField.CALLER, ev),
      [handleSortClick],
    )
    const onCallStackClick = useCallback(
      (ev: MouseEvent) => handleSortClick(InvocationSortField.CALL_STACK, ev),
      [handleSortClick],
    )

    const tableStyle = useMemo(
      () => ({width: '100%', minWidth: tableMinWidth} as const),
      [tableMinWidth],
    )

    const headerTableStyle = useMemo(() => {
      const style: {width: string; minWidth: number; transform?: string} = {
        width: '100%',
        minWidth: tableMinWidth,
      }
      if (scrollLeft !== 0) {
        style.transform = `translateX(-${scrollLeft}px)`
      }
      return style
    }, [tableMinWidth, scrollLeft])

    const onViewportScroll = useCallback((left: number) => {
      setScrollLeft(left)
    }, [])

    const onRowDoubleClick = useCallback((node: CallTreeNode, ev: MouseEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
      profileGroupAtom.focusTreeNode(node)
      viewModeAtom.set(ViewMode.TREE_VIEW)
    }, [])

    const renderItems = useCallback(
      (firstVisibleIndex: number, lastVisibleIndex: number) => {
        const elements: JSX.Element[] = []
        for (let i = firstVisibleIndex; i <= lastVisibleIndex; i++) {
          const row = rows[i]
          if (!row) continue
          const selected = row.node === selectedNode
          const totalPerc = grandTotal === 0 ? 0 : (100.0 * row.total) / grandTotal
          const selfPerc = grandTotal === 0 ? 0 : (100.0 * row.self) / grandTotal
          elements.push(
            <tr
              key={`${i}`}
              onClick={() => setSelectedNode(row.node)}
              onDblClick={ev => onRowDoubleClick(row.node, ev)}
              className={css(
                style.tableRow,
                i % 2 === 1 && style.tableRowEven,
                selected && style.tableRowSelected,
              )}
            >
              <td className={css(style.numericCell)}>
                {profile.formatValue(row.total)} ({formatPercent(totalPerc)})
                <HBarDisplay perc={totalPerc} />
              </td>
              <td className={css(style.numericCell)}>
                {profile.formatValue(row.self)} ({formatPercent(selfPerc)})
                <HBarDisplay perc={selfPerc} />
              </td>
              <td className={css(style.callerCell)} title={row.callerName}>
                {row.callerName}
              </td>
              <td className={css(style.textCell)} title={row.stackLabel}>
                {row.stackLabel}
              </td>
            </tr>,
          )
        }
        return (
          <table className={css(style.tableView)} style={tableStyle}>
            {renderColGroup()}
            {elements}
          </table>
        )
      },
      [
        rows,
        selectedNode,
        grandTotal,
        profile,
        style.tableRow,
        style.tableRowEven,
        style.tableRowSelected,
        style.numericCell,
        style.callerCell,
        style.textCell,
        style.tableView,
        renderColGroup,
        tableStyle,
        onRowDoubleClick,
      ],
    )

    const listItems: ListItem[] = useMemo(
      () => rows.map(() => ({size: Sizes.FRAME_HEIGHT})),
      [rows],
    )

    const progressLabel = `${found.toLocaleString()} / ${expected.toLocaleString()}`
    const progressPerc = expected === 0 ? 100 : Math.min(100, (100 * found) / expected)

    const activeDirection = (field: InvocationSortField): SortDirection | null =>
      sortMethod.field === field ? toSortDirection(sortMethod.direction) : null

    return (
      <div className={css(commonStyle.vbox, style.root)}>
        {!done && (
          <div className={css(style.progressStrip)}>
            <div className={css(style.progressLabel)}>{progressLabel}</div>
            <div className={css(style.progressTrack)}>
              <div className={css(style.progressFill)} style={{width: `${progressPerc}%`}} />
            </div>
          </div>
        )}
        <div className={css(style.headerScrollClip)}>
          <table className={css(style.tableView)} style={headerTableStyle}>
            {renderColGroup()}
            <thead className={css(style.tableHeader, !done && style.tableHeaderDisabled)}>
            <tr>
              <th className={css(style.headerCell, style.numericCell)} onClick={onTotalClick}>
                <SortIcon activeDirection={activeDirection(InvocationSortField.TOTAL)} />
                Total
                <ColumnResizeHandle
                  columnIndex={0}
                  active={draggingColumn === 0}
                  onResizeStart={startResize}
                  onAutoSize={autoSizeColumn}
                />
              </th>
              <th className={css(style.headerCell, style.numericCell)} onClick={onSelfClick}>
                <SortIcon activeDirection={activeDirection(InvocationSortField.SELF)} />
                Self
                <ColumnResizeHandle
                  columnIndex={1}
                  active={draggingColumn === 1}
                  onResizeStart={startResize}
                  onAutoSize={autoSizeColumn}
                />
              </th>
              <th className={css(style.headerCell, style.callerCell)} onClick={onCallerClick}>
                <SortIcon activeDirection={activeDirection(InvocationSortField.CALLER)} />
                Caller
                <ColumnResizeHandle
                  columnIndex={2}
                  active={draggingColumn === 2}
                  onResizeStart={startResize}
                  onAutoSize={autoSizeColumn}
                />
              </th>
              <th className={css(style.headerCell, style.textCell)} onClick={onCallStackClick}>
                <SortIcon activeDirection={activeDirection(InvocationSortField.CALL_STACK)} />
                Call stack
                <ColumnResizeHandle
                  columnIndex={3}
                  active={draggingColumn === 3}
                  onResizeStart={startResize}
                  onAutoSize={autoSizeColumn}
                />
              </th>
            </tr>
            </thead>
          </table>
        </div>
        {rows.length === 0 && done ? (
          <div className={css(style.emptyState)}>No invocations</div>
        ) : (
          <ScrollableListView
            axis={'y'}
            items={listItems}
            className={css(style.scrollView)}
            renderItems={renderItems}
            onViewportScroll={onViewportScroll}
          />
        )}
      </div>
    )
  },
)

const getStyle = withTheme(theme =>
  StyleSheet.create({
    root: {
      background: theme.bgPrimaryColor,
      height: '100%',
      minHeight: 0,
      flex: 1,
    },
    progressStrip: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '6px 10px',
      borderBottom: `1px solid ${theme.bgSecondaryColor}`,
      flexShrink: 0,
    },
    progressLabel: {
      fontSize: FontSize.LABEL,
      color: theme.fgSecondaryColor,
    },
    progressTrack: {
      height: 3,
      background: theme.bgSecondaryColor,
      borderRadius: 2,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      background: theme.weightColor,
    },
    headerScrollClip: {
      overflow: 'hidden',
      flexShrink: 0,
    },
    scrollView: {
      overflowY: 'auto',
      overflowX: 'auto',
      flexGrow: 1,
      '::-webkit-scrollbar': {
        background: theme.bgPrimaryColor,
      },
      '::-webkit-scrollbar-thumb': {
        background: theme.fgSecondaryColor,
        borderRadius: 20,
        border: `3px solid ${theme.bgPrimaryColor}`,
        ':hover': {
          background: theme.fgPrimaryColor,
        },
      },
    },
    tableView: {
      width: '100%',
      fontSize: FontSize.LABEL,
      background: theme.bgPrimaryColor,
      tableLayout: 'fixed',
    },
    tableHeader: {
      borderBottom: `2px solid ${theme.bgSecondaryColor}`,
      textAlign: 'left',
      color: theme.fgPrimaryColor,
      userSelect: 'none',
    },
    headerCell: {
      position: 'relative',
      cursor: 'pointer',
    },
    tableHeaderDisabled: {
      cursor: 'default',
      opacity: 0.7,
    },
    sortIcon: {
      position: 'relative',
      top: 1,
      marginRight: Sizes.FRAME_HEIGHT / 4,
    },
    tableRow: {
      background: theme.bgPrimaryColor,
      height: Sizes.FRAME_HEIGHT,
      cursor: 'pointer',
    },
    tableRowEven: {
      background: theme.bgSecondaryColor,
    },
    tableRowSelected: {
      background: theme.selectionPrimaryColor,
      color: theme.altFgPrimaryColor,
    },
    numericCell: {
      textOverflow: 'ellipsis',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      position: 'relative',
      textAlign: 'right',
      paddingRight: Sizes.FRAME_HEIGHT,
    },
    callerCell: {
      textOverflow: 'ellipsis',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      paddingLeft: 4,
      paddingRight: 4,
    },
    textCell: {
      textOverflow: 'ellipsis',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      paddingLeft: 4,
      paddingRight: 4,
    },
    hBarDisplay: {
      position: 'absolute',
      background: Color.fromCSSHex(theme.weightColor).withAlpha(0.2).toCSS(),
      bottom: 2,
      height: 2,
      width: `calc(100% - ${2 * Sizes.FRAME_HEIGHT}px)`,
      right: Sizes.FRAME_HEIGHT,
    },
    hBarDisplayFilled: {
      height: '100%',
      position: 'absolute',
      background: theme.weightColor,
      right: 0,
    },
    emptyState: {
      textAlign: 'center',
      fontWeight: 'bold',
      padding: 20,
      color: theme.fgSecondaryColor,
    },
  }),
)
