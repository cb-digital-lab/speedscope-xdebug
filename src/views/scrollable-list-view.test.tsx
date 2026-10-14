import {h, render} from 'preact'
import {act} from 'preact/test-utils'
import {ScrollableListView} from './scrollable-list-view'

test('scrolls a new selected item into view without remounting the list', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const items = Array.from({length: 100}, () => ({size: 20}))
  const renderItems = (first: number, last: number) => {
    const rows = []
    for (let i = first; i <= last; i++) rows.push(<div>row {i}</div>)
    return rows
  }
  const rect = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  rect.mockReturnValue({height: 60, width: 200} as DOMRect)
  const raf = jest.spyOn(window, 'requestAnimationFrame')
  raf.mockImplementation(cb => {
    cb(0)
    return 1
  })
  const originalScrollTo = HTMLElement.prototype.scrollTo
  HTMLElement.prototype.scrollTo = function (options: any) {
    this.scrollTop = options.top ?? 0
    this.dispatchEvent(new Event('scroll'))
  }
  try {
    await act(() =>
      render(
        <ScrollableListView
          items={items}
          axis="y"
          renderItems={renderItems}
          initialIndexInView={0}
        />,
        container,
      ),
    )
    expect(container.textContent).toContain('row 0')
    const viewport = container.firstChild
    await act(() =>
      render(
        <ScrollableListView
          items={items}
          axis="y"
          renderItems={renderItems}
          initialIndexInView={50}
        />,
        container,
      ),
    )
    expect(container.firstChild).toBe(viewport)
    expect(container.textContent).toContain('row 50')
  } finally {
    render(null, container)
    container.remove()
    rect.mockRestore()
    raf.mockRestore()
    HTMLElement.prototype.scrollTo = originalScrollTo
  }
})
