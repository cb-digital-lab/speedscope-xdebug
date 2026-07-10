import {memo} from 'preact/compat'
import {useContext, useMemo} from 'preact/hooks'
import {SearchView} from './search-view'
import {h} from 'preact'
import {TreeViewContext} from './tree-view'

export const TreeSearchView = memo(() => {
  const treeViewContext = useContext(TreeViewContext)

  const matchingRows =
    treeViewContext == null
      ? null
      : treeViewContext.rowList.filter(
          row => treeViewContext.getSearchMatchForNode(row.node) != null,
        )

  const numResults = matchingRows != null ? matchingRows.length : null

  const {selectPrev, selectNext} = useMemo(() => {
    if (matchingRows == null || numResults == null || numResults === 0 || treeViewContext == null) {
      return {selectPrev: () => {}, selectNext: () => {}}
    }

    const currentMatchIndex =
      treeViewContext.selectedNode == null
        ? -1
        : matchingRows.findIndex(row => row.node === treeViewContext.selectedNode)

    return {
      selectPrev: () => {
        let index = currentMatchIndex < 0 ? numResults - 1 : currentMatchIndex - 1
        if (index < 0) index = numResults - 1
        treeViewContext.setSelectedNode(matchingRows[index].node)
      },
      selectNext: () => {
        let index = currentMatchIndex < 0 ? 0 : currentMatchIndex + 1
        if (index >= numResults) index = 0
        treeViewContext.setSelectedNode(matchingRows[index].node)
      },
    }
  }, [treeViewContext, matchingRows, numResults])

  const searchResultIndex =
    treeViewContext?.selectedNode != null && matchingRows != null
      ? matchingRows.findIndex(row => row.node === treeViewContext.selectedNode)
      : null

  return (
    <SearchView
      resultIndex={searchResultIndex != null && searchResultIndex >= 0 ? searchResultIndex : null}
      numResults={numResults}
      selectPrev={selectPrev}
      selectNext={selectNext}
    />
  )
})
