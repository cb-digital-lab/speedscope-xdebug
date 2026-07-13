import {h, ComponentChildren} from 'preact'
import {StyleSheet, css, StyleDeclarationValue} from 'aphrodite'
import {memo} from 'preact/compat'
import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks'
import {clamp} from '../lib/math'
import {commonStyle} from './style'
import {useTheme, withTheme} from './themes/theme'
import {splitPanelRightWidthAtom} from '../app-state'
import {useAtom} from '../lib/atom'

const SEPARATOR_HIT_WIDTH = 6

interface ResizableSplitViewProps {
  left: ComponentChildren
  right: ComponentChildren | null
  minLeftWidth?: number
  minRightWidth?: number
  className?: StyleDeclarationValue
}

export const ResizableSplitView = memo(
  ({left, right, minLeftWidth = 200, minRightWidth = 200, className}: ResizableSplitViewProps) => {
    const theme = useTheme()
    const style = getStyle(theme)
    const storedRightWidth = useAtom(splitPanelRightWidthAtom)
    const containerRef = useRef<HTMLDivElement | null>(null)
    const [containerWidth, setContainerWidth] = useState<number | null>(null)
    const [dragging, setDragging] = useState(false)
    const dragStartRef = useRef<{startX: number; startWidth: number} | null>(null)

    useEffect(() => {
      const container = containerRef.current
      if (container == null) return

      const updateWidth = () => {
        setContainerWidth(container.getBoundingClientRect().width)
      }

      updateWidth()
      const observer = new ResizeObserver(updateWidth)
      observer.observe(container)
      return () => observer.disconnect()
    }, [])

    const rightWidth = useMemo(() => {
      if (right == null || containerWidth == null) return null

      const defaultWidth = Math.round(containerWidth * 0.5)
      const width = storedRightWidth ?? defaultWidth
      const maxRight = containerWidth - minLeftWidth - SEPARATOR_HIT_WIDTH
      return clamp(width, minRightWidth, maxRight)
    }, [right, containerWidth, storedRightWidth, minLeftWidth, minRightWidth])

    const leftWidth = useMemo(() => {
      if (right == null || containerWidth == null || rightWidth == null) return null
      return containerWidth - rightWidth - SEPARATOR_HIT_WIDTH
    }, [right, containerWidth, rightWidth])

    const endDrag = useCallback(() => {
      dragStartRef.current = null
      setDragging(false)
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }, [])

    const onMouseMove = useCallback(
      (ev: MouseEvent) => {
        if (dragStartRef.current == null || containerWidth == null) return

        const delta = dragStartRef.current.startX - ev.clientX
        const newWidth = dragStartRef.current.startWidth + delta
        const maxRight = containerWidth - minLeftWidth - SEPARATOR_HIT_WIDTH
        splitPanelRightWidthAtom.set(clamp(newWidth, minRightWidth, maxRight))
      },
      [containerWidth, minLeftWidth, minRightWidth],
    )

    const onMouseUp = useCallback(() => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      endDrag()
    }, [endDrag, onMouseMove])

    const onSeparatorMouseDown = useCallback(
      (ev: MouseEvent) => {
        if (rightWidth == null) return

        ev.preventDefault()
        dragStartRef.current = {startX: ev.clientX, startWidth: rightWidth}
        setDragging(true)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        window.addEventListener('mousemove', onMouseMove)
        window.addEventListener('mouseup', onMouseUp)
      },
      [onMouseMove, onMouseUp, rightWidth],
    )

    useEffect(() => {
      return () => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        endDrag()
      }
    }, [endDrag, onMouseMove, onMouseUp])

    if (right == null) {
      return (
        <div
          ref={containerRef}
          className={css(commonStyle.hbox, commonStyle.fillY, style.root, className)}
        >
          <div className={css(style.panel, style.leftPanelFull)}>{left}</div>
        </div>
      )
    }

    return (
      <div
        ref={containerRef}
        className={css(commonStyle.hbox, commonStyle.fillY, style.root, className)}
      >
        <div className={css(style.panel, style.leftPanel)} style={{width: leftWidth ?? '50%'}}>
          {left}
        </div>
        <div
          className={css(style.separator, dragging && style.separatorDragging)}
          onMouseDown={onSeparatorMouseDown}
        />
        <div className={css(style.panel, style.rightPanel)} style={{width: rightWidth ?? '50%'}}>
          {right}
        </div>
      </div>
    )
  },
)

const getStyle = withTheme(theme =>
  StyleSheet.create({
    root: {
      width: '100%',
      height: '100%',
    },
    panel: {
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      minHeight: 0,
      height: '100%',
      overflow: 'hidden',
    },
    leftPanel: {
      flexShrink: 0,
      background: theme.bgPrimaryColor,
    },
    leftPanelFull: {
      flex: 1,
      background: theme.bgPrimaryColor,
    },
    rightPanel: {
      flexShrink: 0,
    },
    separator: {
      flexShrink: 0,
      width: SEPARATOR_HIT_WIDTH,
      cursor: 'col-resize',
      background: theme.fgSecondaryColor,
      position: 'relative',
      ':hover': {
        background: theme.fgPrimaryColor,
      },
    },
    separatorDragging: {
      background: theme.fgPrimaryColor,
    },
  }),
)
