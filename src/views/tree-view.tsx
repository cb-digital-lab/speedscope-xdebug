import {h, JSX, ComponentChild, createContext} from 'preact'
import {StyleSheet, css} from 'aphrodite'
import {memo} from 'preact/compat'
import {useCallback, useContext, useMemo} from 'preact/hooks'
import {CallTreeNode, Profile} from '../lib/profile'
import {CallTreeRow} from '../lib/call-tree-rows'
import {formatPercent} from '../lib/utils'
import {FontSize, Sizes, commonStyle} from './style'
import {ColorChit} from './color-chit'
import {ListItem, ScrollableListView} from './scrollable-list-view'
import {Color} from '../lib/color'
import {useTheme, withTheme} from './themes/theme'
import {CallTreeNodeDetailView} from './flamechart-detail-view'
import {TreeSearchView} from './tree-search-view'
import {ActiveProfileState} from '../app-state/active-profile-state'
import {SortDirection, TreeSortField, TreeSortMethod} from '../app-state'
import {StatelessComponent} from '../lib/preact-helpers'
import {Theme} from './themes/theme'
import {ResizableSplitView} from './resizable-split-view'

const TREE_INDENT_PX = 12

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

function highlightRanges(
  text: string,
  ranges: [number, number][],
  highlightedClassName: string,
): JSX.Element {
  const spans: ComponentChild[] = []
  let last = 0
  for (let range of ranges) {
    spans.push(text.slice(last, range[0]))
    spans.push(<span className={highlightedClassName}>{text.slice(range[0], range[1])}</span>)
    last = range[1]
  }
  spans.push(text.slice(last))

  return <span>{spans}</span>
}

interface TreeTableRowViewProps {
  row: CallTreeRow
  index: number
  profile: Profile
  selectedNode: CallTreeNode | null
  setSelectedNode: (node: CallTreeNode) => void
  toggleNodeExpanded: (node: CallTreeNode) => void
  getCSSColorForFrame: (frame: import('../lib/profile').Frame) => string
  matchedRanges: [number, number][] | null
}

function TreeTableRowView({
  row,
  profile,
  index,
  selectedNode,
  setSelectedNode,
  toggleNodeExpanded,
  getCSSColorForFrame,
  matchedRanges,
}: TreeTableRowViewProps) {
  const style = getStyle(useTheme())
  const {node, depth, hasChildren, isExpanded} = row
  const {frame} = node

  const totalWeight = node.getTotalWeight()
  const selfWeight = node.getSelfWeight()
  const totalPerc = (100.0 * totalWeight) / profile.getTotalNonIdleWeight()
  const selfPerc = (100.0 * selfWeight) / profile.getTotalNonIdleWeight()

  const selected = node === selectedNode

  const onChevronClick = (ev: MouseEvent) => {
    ev.stopPropagation()
    toggleNodeExpanded(node)
  }

  const onRowClick = () => {
    setSelectedNode(node)
  }

  const onRowDoubleClick = (ev: MouseEvent) => {
    if (hasChildren) {
      ev.preventDefault()
      toggleNodeExpanded(node)
    }
  }

  return (
    <tr
      key={`${index}`}
      onClick={onRowClick}
      onDblClick={onRowDoubleClick}
      className={css(
        style.tableRow,
        index % 2 == 0 && style.tableRowEven,
        selected && style.tableRowSelected,
      )}
    >
      <td className={css(style.numericCell)}>
        {profile.formatValue(totalWeight)} ({formatPercent(totalPerc)})
        <HBarDisplay perc={totalPerc} />
      </td>
      <td className={css(style.numericCell)}>
        {profile.formatValue(selfWeight)} ({formatPercent(selfPerc)})
        <HBarDisplay perc={selfPerc} />
      </td>
      <td title={frame.file} className={css(style.textCell)}>
        <span className={css(style.symbolCell)} style={{paddingLeft: depth * TREE_INDENT_PX}}>
          {hasChildren ? (
            <span className={css(style.chevron)} onClick={onChevronClick}>
              {isExpanded ? '▼' : '▶'}
            </span>
          ) : (
            <span className={css(style.chevronPlaceholder)} />
          )}
          <ColorChit color={getCSSColorForFrame(frame)} />
          {matchedRanges
            ? highlightRanges(
                frame.name,
                matchedRanges,
                css(style.matched, selected && style.matchedSelected),
              )
            : frame.name}
        </span>
      </td>
    </tr>
  )
}

export interface TreeViewContextData {
  rowList: CallTreeRow[]
  selectedNode: CallTreeNode | null
  setSelectedNode: (node: CallTreeNode | null) => void
  toggleNodeExpanded: (node: CallTreeNode) => void
  getIndexForNode: (node: CallTreeNode) => number | null
  getSearchMatchForNode: (node: CallTreeNode) => [number, number][] | null
  expandAll: () => void
  collapseAll: () => void
}

export const TreeViewContext = createContext<TreeViewContextData | null>(null)

interface TreeTableViewProps {
  profile: Profile
  selectedNode: CallTreeNode | null
  getCSSColorForFrame: (frame: import('../lib/profile').Frame) => string
  setSelectedNode: (node: CallTreeNode | null) => void
  toggleNodeExpanded: (node: CallTreeNode) => void
  expandAll: () => void
  collapseAll: () => void
  sortMethod: TreeSortMethod
  setSortMethod: (sortMethod: TreeSortMethod) => void
}

export const TreeTableView = memo(
  ({
    profile,
    selectedNode,
    getCSSColorForFrame,
    setSelectedNode,
    toggleNodeExpanded,
    expandAll,
    collapseAll,
    sortMethod,
    setSortMethod,
  }: TreeTableViewProps) => {
    const style = getStyle(useTheme())
    const treeContext = useContext(TreeViewContext)

    const onSortClick = useCallback(
      (field: TreeSortField, ev: MouseEvent) => {
        ev.preventDefault()

        if (sortMethod.field === field) {
          if (field === TreeSortField.CALL_ORDER) {
            return
          }
          setSortMethod({
            field,
            direction:
              sortMethod.direction === SortDirection.ASCENDING
                ? SortDirection.DESCENDING
                : SortDirection.ASCENDING,
          })
        } else {
          switch (field) {
            case TreeSortField.CALL_ORDER: {
              setSortMethod({field, direction: SortDirection.ASCENDING})
              break
            }
            case TreeSortField.SELF: {
              setSortMethod({field, direction: SortDirection.DESCENDING})
              break
            }
            case TreeSortField.TOTAL: {
              setSortMethod({field, direction: SortDirection.DESCENDING})
              break
            }
          }
        }
      },
      [sortMethod, setSortMethod],
    )

    const onTotalClick = useCallback(
      (ev: MouseEvent) => onSortClick(TreeSortField.TOTAL, ev),
      [onSortClick],
    )
    const onSelfClick = useCallback(
      (ev: MouseEvent) => onSortClick(TreeSortField.SELF, ev),
      [onSortClick],
    )
    const onCallOrderClick = useCallback(
      (ev: MouseEvent) => onSortClick(TreeSortField.CALL_ORDER, ev),
      [onSortClick],
    )

    const renderItems = useCallback(
      (firstIndex: number, lastIndex: number) => {
        if (!treeContext) return null

        const rows: JSX.Element[] = []

        for (let i = firstIndex; i <= lastIndex; i++) {
          const row = treeContext.rowList[i]
          const match = treeContext.getSearchMatchForNode(row.node)
          rows.push(
            TreeTableRowView({
              row,
              matchedRanges: match,
              index: i,
              profile,
              selectedNode,
              setSelectedNode,
              toggleNodeExpanded,
              getCSSColorForFrame,
            }),
          )
        }

        if (rows.length === 0) {
          rows.push(
            <tr>
              <td colSpan={3} className={css(style.emptyState)}>
                No call tree nodes found.
              </td>
            </tr>,
          )
        }

        return <table className={css(style.tableView)}>{rows}</table>
      },
      [
        treeContext,
        profile,
        selectedNode,
        setSelectedNode,
        toggleNodeExpanded,
        getCSSColorForFrame,
        style.emptyState,
        style.tableView,
      ],
    )

    const listItems: ListItem[] = useMemo(
      () =>
        treeContext == null ? [] : treeContext.rowList.map(() => ({size: Sizes.FRAME_HEIGHT})),
      [treeContext],
    )

    return (
      <div className={css(commonStyle.vbox, style.treeTableView)}>
        <div className={css(style.treeControls)}>
          <button type="button" className={css(style.controlButton)} onClick={expandAll}>
            Expand all
          </button>
          <button type="button" className={css(style.controlButton)} onClick={collapseAll}>
            Collapse all
          </button>
        </div>
        <table className={css(style.tableView)}>
          <thead className={css(style.tableHeader)}>
            <tr>
              <th className={css(style.numericCell)} onClick={onTotalClick}>
                <SortIcon
                  activeDirection={
                    sortMethod.field === TreeSortField.TOTAL ? sortMethod.direction : null
                  }
                />
                Total
              </th>
              <th className={css(style.numericCell)} onClick={onSelfClick}>
                <SortIcon
                  activeDirection={
                    sortMethod.field === TreeSortField.SELF ? sortMethod.direction : null
                  }
                />
                Self
              </th>
              <th className={css(style.textCell)} onClick={onCallOrderClick}>
                <SortIcon
                  activeDirection={
                    sortMethod.field === TreeSortField.CALL_ORDER ? SortDirection.ASCENDING : null
                  }
                />
                Symbol Name
              </th>
            </tr>
          </thead>
        </table>
        <ScrollableListView
          axis={'y'}
          items={listItems}
          className={css(style.scrollView)}
          renderItems={renderItems}
          initialIndexInView={
            selectedNode == null ? null : treeContext?.getIndexForNode(selectedNode)
          }
        />
      </div>
    )
  },
)

interface TreeViewProps {
  theme: Theme
  activeProfileState: ActiveProfileState
  selectedNode: CallTreeNode | null
  setSelectedNode: (node: CallTreeNode | null) => void
  toggleNodeExpanded: (node: CallTreeNode) => void
  expandAll: () => void
  collapseAll: () => void
  getCSSColorForFrame: (frame: import('../lib/profile').Frame) => string
  sortMethod: TreeSortMethod
  setSortMethod: (sortMethod: TreeSortMethod) => void
}

class TreeView extends StatelessComponent<TreeViewProps> {
  private setSelectedNode = (selectedNode: CallTreeNode | null) => {
    this.props.setSelectedNode(selectedNode)
  }

  onWindowKeyPress = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      this.setSelectedNode(null)
    }
  }

  componentDidMount() {
    window.addEventListener('keydown', this.onWindowKeyPress)
  }
  componentWillUnmount() {
    window.removeEventListener('keydown', this.onWindowKeyPress)
  }

  render() {
    const style = getStyle(this.props.theme)
    const {selectedNode, activeProfileState, getCSSColorForFrame} = this.props
    const {profile} = activeProfileState

    let detailView: JSX.Element | null = null
    if (selectedNode) {
      detailView = (
        <div className={css(style.detailPanel)}>
          <CallTreeNodeDetailView
            grandTotal={profile.getTotalNonIdleWeight()}
            formatValue={profile.formatValue.bind(profile)}
            getCSSColorForFrame={getCSSColorForFrame}
            selectedNode={selectedNode}
            sidePanel={true}
          />
        </div>
      )
    }

    return (
      <ResizableSplitView
        className={style.treeViewRoot}
        left={
          <div className={css(style.tablePanel)}>
            <TreeTableView
              profile={profile}
              selectedNode={selectedNode}
              getCSSColorForFrame={getCSSColorForFrame}
              setSelectedNode={this.setSelectedNode}
              toggleNodeExpanded={this.props.toggleNodeExpanded}
              expandAll={this.props.expandAll}
              collapseAll={this.props.collapseAll}
              sortMethod={this.props.sortMethod}
              setSortMethod={this.props.setSortMethod}
            />
            <TreeSearchView />
          </div>
        }
        right={detailView}
      />
    )
  }
}

const getStyle = withTheme(theme =>
  StyleSheet.create({
    treeViewRoot: {
      background: theme.bgPrimaryColor,
    },
    tablePanel: {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      flex: 1,
      minWidth: 0,
    },
    detailPanel: {
      height: '100%',
      overflow: 'hidden',
      background: theme.bgPrimaryColor,
    },
    treeTableView: {
      background: theme.bgPrimaryColor,
      height: '100%',
      minHeight: 0,
      flex: 1,
    },
    treeControls: {
      display: 'flex',
      gap: Sizes.FRAME_HEIGHT / 2,
      padding: `${Sizes.FRAME_HEIGHT / 4}px ${Sizes.FRAME_HEIGHT}px`,
      borderBottom: `1px solid ${theme.bgSecondaryColor}`,
    },
    controlButton: {
      background: theme.bgSecondaryColor,
      color: theme.fgPrimaryColor,
      border: 'none',
      padding: `2px ${Sizes.FRAME_HEIGHT / 2}px`,
      fontSize: FontSize.LABEL,
      cursor: 'pointer',
      ':hover': {
        background: theme.selectionSecondaryColor,
        color: theme.altFgPrimaryColor,
      },
    },
    scrollView: {
      overflowY: 'auto',
      overflowX: 'hidden',
      flexGrow: 1,
      minHeight: 0,
      background: theme.bgPrimaryColor,
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
    },
    tableHeader: {
      borderBottom: `2px solid ${theme.bgSecondaryColor}`,
      textAlign: 'left',
      color: theme.fgPrimaryColor,
      userSelect: 'none',
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
      width: 6 * Sizes.FRAME_HEIGHT,
      minWidth: 6 * Sizes.FRAME_HEIGHT,
    },
    textCell: {
      textOverflow: 'ellipsis',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      width: '100%',
      maxWidth: 0,
    },
    symbolCell: {
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
    matched: {
      borderBottom: `2px solid ${theme.fgPrimaryColor}`,
    },
    matchedSelected: {
      borderColor: theme.altFgPrimaryColor,
    },
    emptyState: {
      textAlign: 'center',
      fontWeight: 'bold',
    },
  }),
)

export {TreeView}
