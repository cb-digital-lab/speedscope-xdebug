import {CallTreeProfileBuilder} from '../lib/profile'
import {getChronoViewFlamechart, getChronoOverviewFlamechart} from './flamechart-view-container'
import {FlamechartSearchResults, ProfileSearchResults} from '../lib/profile-search'
import {Rect, Vec2} from '../lib/math'

function buildProfile() {
  const builder = new CallTreeProfileBuilder()
  const frames = ['A', 'B', 'C', 'D', 'E'].map(name => ({key: name, name}))
  builder.enterFrame(frames[0], 0)
  for (let i = 1; i < frames.length; i++) builder.enterFrame(frames[i], 100)
  for (let i = frames.length - 1; i > 0; i--) builder.leaveFrame(frames[i], 101)
  builder.leaveFrame(frames[0], 1000)
  return builder.build()
}

test('overview and detail caches retain their geometry across repeated viewport renders', () => {
  const profile = buildProfile()
  const getColorBucketForFrame = () => 0
  const base = {profile, getColorBucketForFrame, viewLeft: 0, viewRight: 1000}
  const overview = {...base, minFrameWidth: 10, quantizedViewportWidth: 1000}
  const detail = {...base, minFrameWidth: 0.01, quantizedViewportWidth: 10}
  const firstOverview = getChronoOverviewFlamechart(overview)
  const firstDetail = getChronoViewFlamechart(detail)
  expect(getChronoOverviewFlamechart(overview)).toBe(firstOverview)
  expect(getChronoViewFlamechart(detail)).toBe(firstDetail)
})

test('search finds a culled deep call and can zoom to its original position and depth', () => {
  const profile = buildProfile()
  const flamechart = getChronoViewFlamechart({
    profile,
    getColorBucketForFrame: () => 0,
    minFrameWidth: 10,
    quantizedViewportWidth: 1000,
    viewLeft: 0,
    viewRight: 1000,
  })
  expect(flamechart.getLayers()).toHaveLength(1)
  const results = new FlamechartSearchResults(
    flamechart,
    new ProfileSearchResults(profile, 'E'),
    profile.getAppendOrderCalltreeRoot(),
  )
  expect(results.count()).toBe(1)
  const match = results.at(0)
  expect(match.configSpaceBounds.origin).toEqual(new Vec2(100, 4))
  const viewport = flamechart.getClampedConfigSpaceViewportRect({
    configSpaceViewportRect: new Rect(
      match.configSpaceBounds.origin.minus(new Vec2(0, 1)),
      new Vec2(1, 2),
    ),
  })
  expect(viewport.origin.y).toBe(3)
  expect(viewport.width()).toBe(1)
})
