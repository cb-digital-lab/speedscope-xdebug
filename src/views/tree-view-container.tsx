import {h} from 'preact'
import {memo} from 'preact/compat'
import {useCallback, useContext, useMemo} from 'preact/hooks'
import {CallTreeNode} from '../lib/profile'
import {buildCallTreeRows, getAllExpandableNodes, getAncestorNodes} from '../lib/call-tree-rows'
import {ActiveProfileState} from '../app-state/active-profile-state'
import {profileGroupAtom, treeSortMethodAtom} from '../app-state'
import {useAtom} from '../lib/atom'
import {createGetCSSColorForFrame, getFrameToColorBucket} from '../app-state/getters'
import {ProfileSearchContext} from './search-view'
import {useTheme} from './themes/theme'
import {TreeView, TreeViewContext, TreeViewContextData} from './tree-view'

interface TreeViewContainerProps {
  activeProfileState: ActiveProfileState
}

export const TreeViewContainer = memo((ownProps: TreeViewContainerProps) => {
  const {activeProfileState} = ownProps
  const {profile, treeViewState} = activeProfileState
  const {expandedNodes, selectedNode} = treeViewState

  const theme = useTheme()
  const profileSearchResults = useContext(ProfileSearchContext)
  const treeSortMethod = useAtom(treeSortMethodAtom)

  const searchExpandedNodes = useMemo(() => {
    if (profileSearchResults == null) {
      return expandedNodes
    }

    const effectiveExpanded = new Set(expandedNodes)
    for (let node of profileSearchResults.getMatchingCallTreeNodes()) {
      for (let ancestor of getAncestorNodes(node)) {
        effectiveExpanded.add(ancestor)
      }
    }
    return effectiveExpanded
  }, [expandedNodes, profileSearchResults])

  const rowList = useMemo(() => {
    return buildCallTreeRows(
      profile.getAppendOrderCalltreeRoot(),
      searchExpandedNodes,
      treeSortMethod,
    )
  }, [profile, searchExpandedNodes, treeSortMethod])

  const setSelectedNode = useCallback((selectedNode: CallTreeNode | null) => {
    profileGroupAtom.setTreeSelectedNode(selectedNode)
  }, [])

  const toggleNodeExpanded = useCallback((node: CallTreeNode) => {
    profileGroupAtom.toggleTreeNodeExpanded(node)
  }, [])

  const expandAll = useCallback(() => {
    profileGroupAtom.setTreeExpandedNodes(
      getAllExpandableNodes(profile.getAppendOrderCalltreeRoot()),
    )
  }, [profile])

  const collapseAll = useCallback(() => {
    profileGroupAtom.setTreeExpandedNodes(new Set())
  }, [])

  const frameToColorBucket = getFrameToColorBucket(profile)
  const getCSSColorForFrame = createGetCSSColorForFrame({theme, frameToColorBucket})

  const getIndexForNode: (node: CallTreeNode) => number | null = useMemo(() => {
    const indexByNode = new Map<CallTreeNode, number>()
    for (let i = 0; i < rowList.length; i++) {
      indexByNode.set(rowList[i].node, i)
    }
    return (node: CallTreeNode) => {
      const index = indexByNode.get(node)
      return index == null ? null : index
    }
  }, [rowList])

  const getSearchMatchForNode: (node: CallTreeNode) => [number, number][] | null = useMemo(() => {
    return (node: CallTreeNode) => {
      if (profileSearchResults == null) return null
      return profileSearchResults.getMatchForFrame(node.frame)
    }
  }, [profileSearchResults])

  const contextData: TreeViewContextData = {
    rowList,
    selectedNode,
    setSelectedNode,
    toggleNodeExpanded,
    getIndexForNode,
    getSearchMatchForNode,
    expandAll,
    collapseAll,
  }

  return (
    <TreeViewContext.Provider value={contextData}>
      <TreeView
        theme={theme}
        activeProfileState={activeProfileState}
        selectedNode={selectedNode}
        setSelectedNode={setSelectedNode}
        toggleNodeExpanded={toggleNodeExpanded}
        expandAll={expandAll}
        collapseAll={collapseAll}
        getCSSColorForFrame={getCSSColorForFrame}
        sortMethod={treeSortMethod}
        setSortMethod={treeSortMethodAtom.set}
      />
    </TreeViewContext.Provider>
  )
})
