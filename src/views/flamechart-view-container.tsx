import {h} from 'preact'
import {CanvasContext} from '../gl/canvas-context'
import {Flamechart} from '../lib/flamechart'
import {FlamechartRenderer, FlamechartRendererOptions} from '../gl/flamechart-renderer'
import {Frame, Profile, CallTreeNode} from '../lib/profile'
import {memoizeByShallowEquality} from '../lib/utils'
import {FlamechartView} from './flamechart-view'
import {
  getRowAtlas,
  createGetColorBucketForFrame,
  getCanvasContext,
  createGetCSSColorForFrame,
  getFrameToColorBucket,
} from '../app-state/getters'
import {Vec2, Rect} from '../lib/math'
import {memo, useCallback} from 'preact/compat'
import {ActiveProfileState} from '../app-state/active-profile-state'
import {FlamechartSearchContextProvider} from './flamechart-search-view'
import {Theme, useTheme} from './themes/theme'
import {FlamechartID, FlamechartViewState} from '../app-state/profile-group'
import {profileGroupAtom} from '../app-state'
import {
  forEachCallWithLOD,
  getFlamechartLODParams,
  getOverviewFlamechartLODParams,
} from '../lib/flamechart-lod'

interface FlamechartSetters {
  setLogicalSpaceViewportSize: (logicalSpaceViewportSize: Vec2) => void
  setConfigSpaceViewportRect: (configSpaceViewportRect: Rect) => void
  setNodeHover: (hover: {node: CallTreeNode; event: MouseEvent} | null) => void
  setSelectedNode: (node: CallTreeNode | null) => void
}

export function useFlamechartSetters(id: FlamechartID): FlamechartSetters {
  return {
    setNodeHover: useCallback(
      (hover: {node: CallTreeNode; event: MouseEvent} | null) => {
        profileGroupAtom.setFlamechartHoveredNode(id, hover)
      },
      [id],
    ),
    setLogicalSpaceViewportSize: useCallback(
      (logicalSpaceViewportSize: Vec2) => {
        profileGroupAtom.setLogicalSpaceViewportSize(id, logicalSpaceViewportSize)
      },
      [id],
    ),
    setConfigSpaceViewportRect: useCallback(
      (configSpaceViewportRect: Rect) => {
        profileGroupAtom.setConfigSpaceViewportRect(id, configSpaceViewportRect)
      },
      [id],
    ),
    setSelectedNode: useCallback(
      (selectedNode: CallTreeNode | null) => {
        profileGroupAtom.setSelectedNode(id, selectedNode)
      },
      [id],
    ),
  }
}

export type FlamechartViewProps = {
  theme: Theme
  canvasContext: CanvasContext
  flamechart: Flamechart
  flamechartRenderer: FlamechartRenderer
  overviewFlamechart?: Flamechart
  overviewFlamechartRenderer?: FlamechartRenderer
  renderInverted: boolean
  getCSSColorForFrame: (frame: Frame) => string
} & FlamechartSetters &
  FlamechartViewState

export const getChronoViewFlamechart = memoizeByShallowEquality(
  ({
    profile,
    getColorBucketForFrame,
    quantizedViewportWidth,
    viewLeft,
    viewRight,
    minFrameWidth,
  }: {
    profile: Profile
    getColorBucketForFrame: (frame: Frame) => number
    quantizedViewportWidth: number
    viewLeft: number
    viewRight: number
    minFrameWidth: number
  }): Flamechart => {
    return new Flamechart({
      allowLODZoom: true,
      getTotalWeight: profile.getTotalWeight.bind(profile),
      getMaxStackDepth: profile.getMaxStackDepth.bind(profile),
      forEachCall: (openFrame, closeFrame) =>
        forEachCallWithLOD(
          profile.getAppendOrderCalltreeRoot(),
          {minFrameWidth, viewLeft, viewRight, quantizedViewportWidth},
          openFrame,
          closeFrame,
        ),
      formatValue: profile.formatValue.bind(profile),
      getColorBucketForFrame,
    })
  },
)

export const createMemoizedFlamechartRenderer = (options?: FlamechartRendererOptions) =>
  memoizeByShallowEquality(
    ({
      canvasContext,
      flamechart,
    }: {
      canvasContext: CanvasContext
      flamechart: Flamechart
    }): FlamechartRenderer => {
      return new FlamechartRenderer(
        canvasContext.gl,
        getRowAtlas(canvasContext),
        flamechart,
        canvasContext.rectangleBatchRenderer,
        canvasContext.flamechartColorPassRenderer,
        options,
      )
    },
  )

// Keep the overview alive while the detail cache changes with the viewport.
export const getChronoOverviewFlamechart = memoizeByShallowEquality(
  (args: Parameters<typeof getChronoViewFlamechart>[0]) => getChronoViewFlamechart(args),
)
const getChronoOverviewFlamechartRenderer = createMemoizedFlamechartRenderer()
const getChronoViewFlamechartRenderer = createMemoizedFlamechartRenderer()

export interface FlamechartViewContainerProps {
  activeProfileState: ActiveProfileState
  glCanvas: HTMLCanvasElement
}

export const ChronoFlamechartView = memo((props: FlamechartViewContainerProps) => {
  const {activeProfileState, glCanvas} = props
  const {profile, chronoViewState} = activeProfileState

  const theme = useTheme()

  const canvasContext = getCanvasContext({theme, canvas: glCanvas})
  const frameToColorBucket = getFrameToColorBucket(profile)
  const getColorBucketForFrame = createGetColorBucketForFrame(frameToColorBucket)
  const getCSSColorForFrame = createGetCSSColorForFrame({theme, frameToColorBucket})

  const totalWeight = profile.getTotalWeight()
  const overviewLOD = getOverviewFlamechartLODParams(totalWeight)
  const detailLOD = getFlamechartLODParams(totalWeight, chronoViewState.configSpaceViewportRect)

  const overviewFlamechart = getChronoOverviewFlamechart({
    profile,
    getColorBucketForFrame,
    ...overviewLOD,
  })
  const overviewFlamechartRenderer = getChronoOverviewFlamechartRenderer({
    canvasContext,
    flamechart: overviewFlamechart,
  })

  const flamechart = getChronoViewFlamechart({
    profile,
    getColorBucketForFrame,
    ...detailLOD,
  })
  const flamechartRenderer = getChronoViewFlamechartRenderer({
    canvasContext,
    flamechart,
  })

  const setters = useFlamechartSetters(FlamechartID.CHRONO)

  return (
    <FlamechartSearchContextProvider
      flamechart={flamechart}
      completeCallTreeRoot={profile.getAppendOrderCalltreeRoot()}
      selectedNode={chronoViewState.selectedNode}
      setSelectedNode={setters.setSelectedNode}
      configSpaceViewportRect={chronoViewState.configSpaceViewportRect}
      setConfigSpaceViewportRect={setters.setConfigSpaceViewportRect}
    >
      <FlamechartView
        theme={theme}
        renderInverted={false}
        flamechart={flamechart}
        flamechartRenderer={flamechartRenderer}
        overviewFlamechart={overviewFlamechart}
        overviewFlamechartRenderer={overviewFlamechartRenderer}
        canvasContext={canvasContext}
        getCSSColorForFrame={getCSSColorForFrame}
        {...chronoViewState}
        {...setters}
      />
    </FlamechartSearchContextProvider>
  )
})

export const getLeftHeavyFlamechart = memoizeByShallowEquality(
  ({
    profile,
    getColorBucketForFrame,
    quantizedViewportWidth,
    viewLeft,
    viewRight,
    minFrameWidth,
  }: {
    profile: Profile
    getColorBucketForFrame: (frame: Frame) => number
    quantizedViewportWidth: number
    viewLeft: number
    viewRight: number
    minFrameWidth: number
  }): Flamechart => {
    return new Flamechart({
      allowLODZoom: true,
      getTotalWeight: profile.getTotalNonIdleWeight.bind(profile),
      getMaxStackDepth: profile.getMaxStackDepth.bind(profile),
      forEachCall: (openFrame, closeFrame) =>
        forEachCallWithLOD(
          profile.getGroupedCalltreeRoot(),
          {minFrameWidth, viewLeft, viewRight, quantizedViewportWidth},
          openFrame,
          closeFrame,
        ),
      formatValue: profile.formatValue.bind(profile),
      getColorBucketForFrame,
    })
  },
)

export const getLeftHeavyOverviewFlamechart = memoizeByShallowEquality(
  (args: Parameters<typeof getLeftHeavyFlamechart>[0]) => getLeftHeavyFlamechart(args),
)
const getLeftHeavyOverviewFlamechartRenderer = createMemoizedFlamechartRenderer()
const getLeftHeavyFlamechartRenderer = createMemoizedFlamechartRenderer()

export const LeftHeavyFlamechartView = memo((ownProps: FlamechartViewContainerProps) => {
  const {activeProfileState, glCanvas} = ownProps

  const {profile, leftHeavyViewState} = activeProfileState

  const theme = useTheme()

  const canvasContext = getCanvasContext({theme, canvas: glCanvas})
  const frameToColorBucket = getFrameToColorBucket(profile)
  const getColorBucketForFrame = createGetColorBucketForFrame(frameToColorBucket)
  const getCSSColorForFrame = createGetCSSColorForFrame({theme, frameToColorBucket})

  const totalWeight = profile.getTotalNonIdleWeight()
  const overviewLOD = getOverviewFlamechartLODParams(totalWeight)
  const detailLOD = getFlamechartLODParams(totalWeight, leftHeavyViewState.configSpaceViewportRect)

  const overviewFlamechart = getLeftHeavyOverviewFlamechart({
    profile,
    getColorBucketForFrame,
    ...overviewLOD,
  })
  const overviewFlamechartRenderer = getLeftHeavyOverviewFlamechartRenderer({
    canvasContext,
    flamechart: overviewFlamechart,
  })

  const flamechart = getLeftHeavyFlamechart({
    profile,
    getColorBucketForFrame,
    ...detailLOD,
  })
  const flamechartRenderer = getLeftHeavyFlamechartRenderer({
    canvasContext,
    flamechart,
  })

  const setters = useFlamechartSetters(FlamechartID.LEFT_HEAVY)

  return (
    <FlamechartSearchContextProvider
      flamechart={flamechart}
      completeCallTreeRoot={profile.getGroupedCalltreeRoot()}
      selectedNode={leftHeavyViewState.selectedNode}
      setSelectedNode={setters.setSelectedNode}
      configSpaceViewportRect={leftHeavyViewState.configSpaceViewportRect}
      setConfigSpaceViewportRect={setters.setConfigSpaceViewportRect}
    >
      <FlamechartView
        theme={theme}
        renderInverted={false}
        flamechart={flamechart}
        flamechartRenderer={flamechartRenderer}
        overviewFlamechart={overviewFlamechart}
        overviewFlamechartRenderer={overviewFlamechartRenderer}
        canvasContext={canvasContext}
        getCSSColorForFrame={getCSSColorForFrame}
        {...leftHeavyViewState}
        {...setters}
      />
    </FlamechartSearchContextProvider>
  )
})
