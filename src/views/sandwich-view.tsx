import {Frame} from '../lib/profile'
import {StyleSheet, css} from 'aphrodite'
import {ProfileTableViewContainer} from './profile-table-view'
import {h, JSX, createContext} from 'preact'
import {memo} from 'preact/compat'
import {useCallback, useMemo, useContext} from 'preact/hooks'
import {commonStyle} from './style'
import {SandwichSearchView} from './sandwich-search-view'
import {SandwichInvocationsView} from './sandwich-invocations-view'
import {ActiveProfileState} from '../app-state/active-profile-state'
import {sortBy} from '../lib/utils'
import {ProfileSearchContext} from './search-view'
import {Theme, useTheme, withTheme} from './themes/theme'
import {SortField, SortDirection, profileGroupAtom, tableSortMethodAtom} from '../app-state'
import {useAtom} from '../lib/atom'
import {StatelessComponent} from '../lib/preact-helpers'
import {ResizableSplitView} from './resizable-split-view'

interface SandwichViewProps {
  selectedFrame: Frame | null
  profileIndex: number
  theme: Theme
  activeProfileState: ActiveProfileState
  setSelectedFrame: (selectedFrame: Frame | null) => void
  glCanvas: HTMLCanvasElement
}

class SandwichView extends StatelessComponent<SandwichViewProps> {
  private setSelectedFrame = (selectedFrame: Frame | null) => {
    this.props.setSelectedFrame(selectedFrame)
  }

  onWindowKeyPress = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      this.setSelectedFrame(null)
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

    const {selectedFrame} = this.props
    let invocationsView: JSX.Element | null = null

    if (selectedFrame) {
      invocationsView = (
        <div className={css(commonStyle.fillY, style.invocationsPanel, commonStyle.vbox)}>
          <SandwichInvocationsView
            profile={this.props.activeProfileState.profile}
            selectedFrame={selectedFrame}
          />
        </div>
      )
    }

    return (
      <ResizableSplitView
        left={
          <div className={css(style.tableView)}>
            <ProfileTableViewContainer activeProfileState={this.props.activeProfileState} />
            <SandwichSearchView />
          </div>
        }
        right={invocationsView}
      />
    )
  }
}

const getStyle = withTheme(_theme =>
  StyleSheet.create({
    tableView: {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      flex: 1,
    },
    invocationsPanel: {
      flex: 1,
      minHeight: 0,
    },
  }),
)

interface SandwichViewContainerProps {
  activeProfileState: ActiveProfileState
  glCanvas: HTMLCanvasElement
}

interface SandwichViewContextData {
  rowList: Frame[]
  selectedFrame: Frame | null
  setSelectedFrame: (frame: Frame | null) => void
  getIndexForFrame: (frame: Frame) => number | null
  getSearchMatchForFrame: (frame: Frame) => [number, number][] | null
}

export const SandwichViewContext = createContext<SandwichViewContextData | null>(null)

export const SandwichViewContainer = memo((ownProps: SandwichViewContainerProps) => {
  const {activeProfileState, glCanvas} = ownProps
  const {sandwichViewState, index} = activeProfileState
  const {callerCallee} = sandwichViewState

  const theme = useTheme()
  const setSelectedFrame = useCallback((selectedFrame: Frame | null) => {
    profileGroupAtom.setSelectedFrame(selectedFrame)
  }, [])

  const profile = activeProfileState.profile
  const tableSortMethod = useAtom(tableSortMethodAtom)
  const profileSearchResults = useContext(ProfileSearchContext)

  const selectedFrame = callerCallee ? callerCallee.selectedFrame : null

  const rowList: Frame[] = useMemo(() => {
    const rowList: Frame[] = []

    profile.forEachFrame(frame => {
      if (profileSearchResults && !profileSearchResults.getMatchForFrame(frame)) {
        return
      }
      rowList.push(frame)
    })

    switch (tableSortMethod.field) {
      case SortField.SYMBOL_NAME: {
        sortBy(rowList, f => f.name.toLowerCase())
        break
      }
      case SortField.SELF: {
        sortBy(rowList, f => f.getSelfWeight())
        break
      }
      case SortField.TOTAL: {
        sortBy(rowList, f => f.getTotalWeight())
        break
      }
      case SortField.COUNT: {
        sortBy(rowList, f => f.getCallCount())
        break
      }
    }
    if (tableSortMethod.direction === SortDirection.DESCENDING) {
      rowList.reverse()
    }

    return rowList
  }, [profile, profileSearchResults, tableSortMethod])

  const getIndexForFrame: (frame: Frame) => number | null = useMemo(() => {
    const indexByFrame = new Map<Frame, number>()
    for (let i = 0; i < rowList.length; i++) {
      indexByFrame.set(rowList[i], i)
    }
    return (frame: Frame) => {
      const index = indexByFrame.get(frame)
      return index == null ? null : index
    }
  }, [rowList])

  const getSearchMatchForFrame: (frame: Frame) => [number, number][] | null = useMemo(() => {
    return (frame: Frame) => {
      if (profileSearchResults == null) return null
      return profileSearchResults.getMatchForFrame(frame)
    }
  }, [profileSearchResults])

  const contextData: SandwichViewContextData = {
    rowList,
    selectedFrame,
    setSelectedFrame,
    getIndexForFrame,
    getSearchMatchForFrame,
  }

  return (
    <SandwichViewContext.Provider value={contextData}>
      <SandwichView
        theme={theme}
        activeProfileState={activeProfileState}
        glCanvas={glCanvas}
        setSelectedFrame={setSelectedFrame}
        selectedFrame={selectedFrame}
        profileIndex={index}
      />
    </SandwichViewContext.Provider>
  )
})
