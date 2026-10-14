import {h, JSX, Fragment} from 'preact'
import {StyleSheet, css} from 'aphrodite'
import {memo} from 'preact/compat'
import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks'
import {Frame, Profile, CallTreeNode} from '../lib/profile'
import {formatPercent} from '../lib/utils'
import {
  ChunkedCollector,
  createChunkedInvocationCollector,
  flattenCallerGroups,
  FlattenedInvocationListRow,
  flattenStackTree,
  buildInvocationStackTree,
  formatStackTreeLabel,
  groupInvocationsByCaller,
  InvocationRow,
  InvocationSortField,
  InvocationSortMethod,
  sortCallerGroups,
  sortInvocationRows,
  sortStackTree,
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
const FLAT_COLUMN_WIDTHS = [3 * REM, 3 * REM, 10 * REM, 12 * REM]
const FLAT_MIN_WIDTHS = [2 * REM, 2 * REM, 3 * REM, 3 * REM]
const GROUPED_COLUMN_WIDTHS = [3 * REM, 3 * REM, 3 * REM, 10 * REM, 12 * REM]
const GROUPED_MIN_WIDTHS = [2 * REM, 2 * REM, 2 * REM, 3 * REM, 3 * REM]
const STACK_COLUMN_WIDTHS = [3 * REM, 3 * REM, 3 * REM, 16 * REM]
const STACK_MIN_WIDTHS = [2 * REM, 2 * REM, 2 * REM, 6 * REM]
const TREE_INDENT_PX = 12

const DEFAULT_SORT: InvocationSortMethod = {
  field: InvocationSortField.TOTAL,
  direction: 'DESCENDING',
}

enum GroupMode {
  FLAT = 'FLAT',
  BY_CALLER = 'BY_CALLER',
  BY_STACK = 'BY_STACK',
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

function preventDoubleClickTextSelection(ev: MouseEvent) {
  if (ev.detail > 1) {
    ev.preventDefault()
  }
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
    const [groupMode, setGroupMode] = useState<GroupMode>(GroupMode.FLAT)
    const [expandedCallers, setExpandedCallers] = useState<Set<string>>(() => new Set())
    const [expandedStackKeys, setExpandedStackKeys] = useState<Set<string>>(() => new Set())
    const [selectedNode, setSelectedNode] = useState<InvocationRow['node'] | null>(null)
    const [selectedCallerKey, setSelectedCallerKey] = useState<string | null>(null)
    const [selectedStackKey, setSelectedStackKey] = useState<string | null>(null)
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
      setSelectedCallerKey(null)
      setSelectedStackKey(null)
      setExpandedCallers(new Set())
      setExpandedStackKeys(new Set())

      const collector = createChunkedInvocationCollector(profile, selectedFrame)
      collectorRef.current = collector

      const tick = () => {
        if (collectorRef.current !== collector) return
        const result = collector.pull(CHUNK_SIZE)
        setFound(result.found)
        setExpected(result.expected)
        if (result.done) {
          setRows(result.rows.slice())
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

    const sortedRows = useMemo(() => {
      if (groupMode !== GroupMode.FLAT) return []
      const sorted = rows.slice()
      if (done) sortInvocationRows(sorted, sortMethod)
      return sorted
    }, [rows, done, sortMethod, groupMode])

    const callerGroups = useMemo(() => {
      if (groupMode !== GroupMode.BY_CALLER) return []
      const groups = groupInvocationsByCaller(rows)
      if (done) sortCallerGroups(groups, sortMethod)
      return groups
    }, [rows, done, sortMethod, groupMode])

    const stackTree = useMemo(() => {
      if (groupMode !== GroupMode.BY_STACK) return []
      const tree = buildInvocationStackTree(rows)
      if (done) sortStackTree(tree, sortMethod)
      return tree
    }, [rows, done, sortMethod, groupMode])

    const displayRows: FlattenedInvocationListRow[] = useMemo(() => {
      if (groupMode === GroupMode.FLAT)
        return sortedRows.map(row => ({kind: 'invocation' as const, row, indented: false}))
      if (groupMode === GroupMode.BY_CALLER)
        return flattenCallerGroups(callerGroups, expandedCallers)
      return flattenStackTree(stackTree, expandedStackKeys)
    }, [sortedRows, callerGroups, stackTree, groupMode, expandedCallers, expandedStackKeys])

    const showCount = groupMode === GroupMode.BY_CALLER || groupMode === GroupMode.BY_STACK
    const showStackTree = groupMode === GroupMode.BY_STACK
    const columnWidths = showStackTree
      ? STACK_COLUMN_WIDTHS
      : showCount
        ? GROUPED_COLUMN_WIDTHS
        : FLAT_COLUMN_WIDTHS
    const minWidths = showStackTree
      ? STACK_MIN_WIDTHS
      : showCount
        ? GROUPED_MIN_WIDTHS
        : FLAT_MIN_WIDTHS

    useEffect(() => {
      if (groupMode === GroupMode.FLAT && sortMethod.field === InvocationSortField.COUNT) {
        setSortMethod(DEFAULT_SORT)
      }
    }, [groupMode, sortMethod.field])

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
            case InvocationSortField.COUNT:
              return {field, direction: 'DESCENDING'}
          }
        })
      },
      [done],
    )

    const grandTotal = profile.getTotalNonIdleWeight()

    const getHeaderText = useCallback(
      (columnIndex: number) => {
        if (showStackTree) {
          switch (columnIndex) {
            case 0:
              return 'Total'
            case 1:
              return 'Self'
            case 2:
              return 'Occurrences'
            case 3:
              return 'Symbol'
            default:
              return ''
          }
        }
        if (showCount) {
          switch (columnIndex) {
            case 0:
              return 'Total'
            case 1:
              return 'Self'
            case 2:
              return 'Occurrences'
            case 3:
              return 'Caller'
            case 4:
              return 'Call stack'
            default:
              return ''
          }
        }
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
      },
      [showCount, showStackTree],
    )

    const getCellText = useCallback(
      (rowIndex: number, columnIndex: number) => {
        const displayRow = displayRows[rowIndex]
        if (!displayRow) return ''

        if (displayRow.kind === 'stack') {
          switch (columnIndex) {
            case 0: {
              const totalPerc = grandTotal === 0 ? 0 : (100.0 * displayRow.node.total) / grandTotal
              return `${profile.formatValue(displayRow.node.total)} (${formatPercent(totalPerc)})`
            }
            case 1: {
              const selfPerc = grandTotal === 0 ? 0 : (100.0 * displayRow.node.self) / grandTotal
              return `${profile.formatValue(displayRow.node.self)} (${formatPercent(selfPerc)})`
            }
            case 2:
              return displayRow.node.count.toLocaleString()
            case 3:
              return formatStackTreeLabel(displayRow.node)
            default:
              return ''
          }
        }

        if (displayRow.kind === 'group') {
          if (showCount) {
            switch (columnIndex) {
              case 0: {
                const totalPerc =
                  grandTotal === 0 ? 0 : (100.0 * displayRow.group.total) / grandTotal
                return `${profile.formatValue(displayRow.group.total)} (${formatPercent(
                  totalPerc,
                )})`
              }
              case 1: {
                const selfPerc = grandTotal === 0 ? 0 : (100.0 * displayRow.group.self) / grandTotal
                return `${profile.formatValue(displayRow.group.self)} (${formatPercent(selfPerc)})`
              }
              case 2:
                return displayRow.group.count.toLocaleString()
              case 3:
                return displayRow.group.callerName
              case 4:
                return ''
              default:
                return ''
            }
          }
        }

        if (displayRow.kind !== 'invocation') return ''

        const row = displayRow.row
        if (showCount) {
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
              return ''
            case 3:
              return row.callerName
            case 4:
              return row.stackLabel
            default:
              return ''
          }
        }
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
      [displayRows, grandTotal, profile, showCount],
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
      defaultWidths: columnWidths,
      minWidths,
      getHeaderText,
      getCellText,
      rowCount: displayRows.length,
    })

    const autoSizeColumnsRef = useRef(autoSizeColumns)
    autoSizeColumnsRef.current = autoSizeColumns

    const hasDisplayRows = displayRows.length > 0
    useEffect(() => {
      if (!done || !hasDisplayRows) return
      const indices = showStackTree || showCount ? [0, 1, 2, 3] : [0, 1, 2]
      autoSizeColumnsRef.current(indices)
    }, [done, groupMode, showCount, showStackTree, hasDisplayRows])

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
    const onCountClick = useCallback(
      (ev: MouseEvent) => handleSortClick(InvocationSortField.COUNT, ev),
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
      () => ({width: '100%', minWidth: tableMinWidth}) as const,
      [tableMinWidth],
    )

    const headerTableStyle = useMemo(() => {
      const next: {width: string; minWidth: number; transform?: string} = {
        width: '100%',
        minWidth: tableMinWidth,
      }
      if (scrollLeft !== 0) {
        next.transform = `translateX(-${scrollLeft}px)`
      }
      return next
    }, [tableMinWidth, scrollLeft])

    const onViewportScroll = useCallback((left: number) => {
      setScrollLeft(prev => (prev === left ? prev : left))
    }, [])

    const onRowDoubleClick = useCallback((node: CallTreeNode, ev: MouseEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
      profileGroupAtom.focusTreeNode(node)
      viewModeAtom.set(ViewMode.TREE_VIEW)
    }, [])

    const toggleCallerExpanded = useCallback((callerName: string) => {
      setExpandedCallers(prev => {
        const next = new Set(prev)
        if (next.has(callerName)) {
          next.delete(callerName)
        } else {
          next.add(callerName)
        }
        return next
      })
    }, [])

    const toggleStackExpanded = useCallback((pathKey: string) => {
      setExpandedStackKeys(prev => {
        const next = new Set(prev)
        if (next.has(pathKey)) {
          next.delete(pathKey)
        } else {
          next.add(pathKey)
        }
        return next
      })
    }, [])

    const renderItems = useCallback(
      (firstVisibleIndex: number, lastVisibleIndex: number) => {
        const elements: JSX.Element[] = []
        for (let i = firstVisibleIndex; i <= lastVisibleIndex; i++) {
          const displayRow = displayRows[i]
          if (!displayRow) continue

          if (displayRow.kind === 'stack') {
            const {node, isExpanded, hasChildren} = displayRow
            const selected =
              selectedStackKey === node.pathKey ||
              (node.invocation != null && node.invocation.node === selectedNode)
            const totalPerc = grandTotal === 0 ? 0 : (100.0 * node.total) / grandTotal
            const selfPerc = grandTotal === 0 ? 0 : (100.0 * node.self) / grandTotal
            elements.push(
              <tr
                key={`stack-${node.pathKey}`}
                onMouseDown={preventDoubleClickTextSelection}
                onClick={() => {
                  setSelectedStackKey(node.pathKey)
                  setSelectedCallerKey(null)
                  setSelectedNode(node.invocation ? node.invocation.node : null)
                }}
                onDblClick={ev => {
                  ev.preventDefault()
                  if (node.invocation) {
                    onRowDoubleClick(node.invocation.node, ev)
                    return
                  }
                  if (hasChildren) {
                    toggleStackExpanded(node.pathKey)
                  }
                }}
                className={css(
                  style.tableRow,
                  i % 2 === 1 && style.tableRowEven,
                  selected && style.tableRowSelected,
                )}
              >
                <td className={css(style.numericCell)}>
                  {profile.formatValue(node.total)} ({formatPercent(totalPerc)})
                  <HBarDisplay perc={totalPerc} />
                </td>
                <td className={css(style.numericCell)}>
                  {profile.formatValue(node.self)} ({formatPercent(selfPerc)})
                  <HBarDisplay perc={selfPerc} />
                </td>
                <td className={css(style.countCell)}>{node.count.toLocaleString()}</td>
                <td className={css(style.textCell)} title={formatStackTreeLabel(node)}>
                  <span
                    className={css(style.callerCellInner)}
                    style={{paddingLeft: node.depth * TREE_INDENT_PX}}
                  >
                    {hasChildren ? (
                      <span
                        className={css(style.chevron)}
                        onClick={ev => {
                          ev.stopPropagation()
                          toggleStackExpanded(node.pathKey)
                        }}
                      >
                        {isExpanded ? '▼' : '▶'}
                      </span>
                    ) : (
                      <span className={css(style.chevronPlaceholder)} />
                    )}
                    {formatStackTreeLabel(node)}
                  </span>
                </td>
              </tr>,
            )
            continue
          }

          if (displayRow.kind === 'group') {
            const {group, isExpanded} = displayRow
            const selected = selectedCallerKey === group.key && selectedNode == null
            const totalPerc = grandTotal === 0 ? 0 : (100.0 * group.total) / grandTotal
            const selfPerc = grandTotal === 0 ? 0 : (100.0 * group.self) / grandTotal
            elements.push(
              <tr
                key={`group-${group.key}`}
                onMouseDown={preventDoubleClickTextSelection}
                onClick={() => {
                  setSelectedCallerKey(group.key)
                  setSelectedNode(null)
                }}
                onDblClick={ev => {
                  ev.preventDefault()
                  toggleCallerExpanded(group.key)
                }}
                className={css(
                  style.tableRow,
                  i % 2 === 1 && style.tableRowEven,
                  selected && style.tableRowSelected,
                )}
              >
                <td className={css(style.numericCell)}>
                  {profile.formatValue(group.total)} ({formatPercent(totalPerc)})
                  <HBarDisplay perc={totalPerc} />
                </td>
                <td className={css(style.numericCell)}>
                  {profile.formatValue(group.self)} ({formatPercent(selfPerc)})
                  <HBarDisplay perc={selfPerc} />
                </td>
                {showCount ? (
                  <td className={css(style.countCell)}>{group.count.toLocaleString()}</td>
                ) : null}
                <td
                  className={css(style.callerCell)}
                  title={
                    group.callerFile
                      ? `${group.callerName} [${group.callerFile}]`
                      : group.callerName
                  }
                >
                  <span className={css(style.callerCellInner)}>
                    <span
                      className={css(style.chevron)}
                      onClick={ev => {
                        ev.stopPropagation()
                        toggleCallerExpanded(group.key)
                      }}
                    >
                      {isExpanded ? '▼' : '▶'}
                    </span>
                    {group.callerName}
                  </span>
                </td>
                <td className={css(style.textCell)} />
              </tr>,
            )
            continue
          }

          const row = displayRow.row
          const selected = row.node === selectedNode
          const totalPerc = grandTotal === 0 ? 0 : (100.0 * row.total) / grandTotal
          const selfPerc = grandTotal === 0 ? 0 : (100.0 * row.self) / grandTotal
          elements.push(
            <tr
              key={`inv-${i}`}
              onMouseDown={preventDoubleClickTextSelection}
              onClick={() => {
                setSelectedNode(row.node)
                setSelectedCallerKey(null)
              }}
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
              {showCount ? <td className={css(style.countCell)} /> : null}
              <td className={css(style.callerCell)} title={row.callerName}>
                <span className={css(style.callerCellInner)}>
                  {displayRow.indented ? <span className={css(style.chevronPlaceholder)} /> : null}
                  {row.callerName}
                </span>
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
        displayRows,
        selectedNode,
        selectedCallerKey,
        selectedStackKey,
        grandTotal,
        profile,
        showCount,
        style.tableRow,
        style.tableRowEven,
        style.tableRowSelected,
        style.numericCell,
        style.countCell,
        style.callerCell,
        style.callerCellInner,
        style.chevron,
        style.chevronPlaceholder,
        style.textCell,
        style.tableView,
        renderColGroup,
        tableStyle,
        onRowDoubleClick,
        toggleCallerExpanded,
        toggleStackExpanded,
      ],
    )

    const listItems: ListItem[] = useMemo(
      () => displayRows.map(() => ({size: Sizes.FRAME_HEIGHT})),
      [displayRows],
    )

    const progressLabel = `${found.toLocaleString()} / ${expected.toLocaleString()}`
    const progressPerc = expected === 0 ? 100 : Math.min(100, (100 * found) / expected)

    const activeDirection = (field: InvocationSortField): SortDirection | null =>
      sortMethod.field === field ? toSortDirection(sortMethod.direction) : null

    return (
      <div className={css(commonStyle.vbox, style.root)}>
        <div className={css(style.modeTabs)}>
          <button
            type="button"
            className={css(style.modeTab, groupMode === GroupMode.FLAT && style.modeTabActive)}
            onClick={() => setGroupMode(GroupMode.FLAT)}
          >
            Flat
          </button>
          <button
            type="button"
            className={css(style.modeTab, groupMode === GroupMode.BY_CALLER && style.modeTabActive)}
            onClick={() => setGroupMode(GroupMode.BY_CALLER)}
          >
            Group by Caller
          </button>
          <button
            type="button"
            className={css(style.modeTab, groupMode === GroupMode.BY_STACK && style.modeTabActive)}
            onClick={() => setGroupMode(GroupMode.BY_STACK)}
          >
            Call tree
          </button>
        </div>
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
                {showCount ? (
                  <th className={css(style.headerCell, style.countCell)} onClick={onCountClick}>
                    <SortIcon activeDirection={activeDirection(InvocationSortField.COUNT)} />
                    Occurrences
                    <ColumnResizeHandle
                      columnIndex={2}
                      active={draggingColumn === 2}
                      onResizeStart={startResize}
                      onAutoSize={autoSizeColumn}
                    />
                  </th>
                ) : null}
                {showStackTree ? (
                  <th className={css(style.headerCell, style.textCell)} onClick={onCallStackClick}>
                    <SortIcon activeDirection={activeDirection(InvocationSortField.CALL_STACK)} />
                    Symbol
                    <ColumnResizeHandle
                      columnIndex={3}
                      active={draggingColumn === 3}
                      onResizeStart={startResize}
                      onAutoSize={autoSizeColumn}
                    />
                  </th>
                ) : (
                  <Fragment>
                    <th className={css(style.headerCell, style.callerCell)} onClick={onCallerClick}>
                      <SortIcon activeDirection={activeDirection(InvocationSortField.CALLER)} />
                      Caller
                      <ColumnResizeHandle
                        columnIndex={showCount ? 3 : 2}
                        active={draggingColumn === (showCount ? 3 : 2)}
                        onResizeStart={startResize}
                        onAutoSize={autoSizeColumn}
                      />
                    </th>
                    <th
                      className={css(style.headerCell, style.textCell)}
                      onClick={onCallStackClick}
                    >
                      <SortIcon activeDirection={activeDirection(InvocationSortField.CALL_STACK)} />
                      Call stack
                      <ColumnResizeHandle
                        columnIndex={showCount ? 4 : 3}
                        active={draggingColumn === (showCount ? 4 : 3)}
                        onResizeStart={startResize}
                        onAutoSize={autoSizeColumn}
                      />
                    </th>
                  </Fragment>
                )}
              </tr>
            </thead>
          </table>
        </div>
        {displayRows.length === 0 && done ? (
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
    modeTabs: {
      display: 'flex',
      flexDirection: 'row',
      gap: 4,
      padding: '6px 8px',
      borderBottom: `1px solid ${theme.bgSecondaryColor}`,
      flexShrink: 0,
    },
    modeTab: {
      appearance: 'none',
      border: `1px solid ${theme.fgSecondaryColor}`,
      background: theme.bgPrimaryColor,
      color: theme.fgSecondaryColor,
      fontSize: FontSize.LABEL,
      padding: '3px 10px',
      cursor: 'pointer',
      borderRadius: 2,
      ':hover': {
        color: theme.fgPrimaryColor,
        borderColor: theme.fgPrimaryColor,
      },
    },
    modeTabActive: {
      background: theme.selectionPrimaryColor,
      borderColor: theme.selectionPrimaryColor,
      color: theme.altFgPrimaryColor,
      ':hover': {
        color: theme.altFgPrimaryColor,
        borderColor: theme.selectionPrimaryColor,
      },
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
      userSelect: 'none',
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
    countCell: {
      textOverflow: 'ellipsis',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
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
    callerCellInner: {
      display: 'inline-flex',
      alignItems: 'center',
      maxWidth: '100%',
    },
    chevron: {
      display: 'inline-block',
      width: Sizes.FRAME_HEIGHT,
      flexShrink: 0,
      textAlign: 'center',
      cursor: 'pointer',
      userSelect: 'none',
    },
    chevronPlaceholder: {
      display: 'inline-block',
      width: Sizes.FRAME_HEIGHT,
      flexShrink: 0,
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
