import { useEffect, useState, type RefObject } from 'react'

/** 找到最近的纵向滚动容器，用于判断 sticky 元素是否已经吸附在顶部。 */
const findScrollParent = (element: HTMLElement) => {
  let parent = element.parentElement
  while (parent) {
    const overflowY = getComputedStyle(parent).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return parent
    }
    parent = parent.parentElement
  }
  return null
}

/**
 * 通过代码块顶部的 1px 探针判断 sticky 标题栏是否已吸附：
 * 探针离开滚动容器顶部时，标题栏已脱离代码块原位。
 */
export const useStickyBanner = (
  blockRef: RefObject<HTMLElement>,
  sentinelRef: RefObject<HTMLElement>
) => {
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    const block = blockRef.current
    const sentinel = sentinelRef.current
    if (!block || !sentinel) {
      return
    }
    const scrollParent = findScrollParent(block)
    const update = () => {
      const viewportTop = scrollParent ? scrollParent.getBoundingClientRect().top : 0
      setStuck(block.getBoundingClientRect().top < viewportTop - 0.5)
    }
    const observer = new IntersectionObserver(update, {
      root: scrollParent,
      threshold: 0,
    })
    observer.observe(sentinel)
    update()
    return () => observer.disconnect()
  }, [blockRef, sentinelRef])

  return stuck
}
