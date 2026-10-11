import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { cn } from '@/lib/utils'

const VIRTUALIZATION_THRESHOLD = 50

/**
 * Renders an item list, switching to virtualization when the row count
 * exceeds the threshold. `renderItem` returns the row content only —
 * VirtualList owns the wrapper element (`<ul>/<li>` in inline mode,
 * `<div>`s in virtualized mode) so callers don't have to think about
 * the two paths.
 *
 * In virtualized mode a self-contained `max-h` scroller is used so
 * the outer panel's scroll UX remains unbroken; this only kicks in
 * for the pathological "hundreds of shapes" case where the perf win
 * is worth the nested scroll.
 */
export function VirtualList<T>({
  items,
  renderItem,
  estimatedRowHeight = 36,
  gapPx = 4,
  className,
  maxHeightClassName = 'max-h-[40dvh]',
  keyFor,
}: {
  items: ReadonlyArray<T>
  renderItem: (item: T, index: number) => React.ReactNode
  estimatedRowHeight?: number
  gapPx?: number
  className?: string
  maxHeightClassName?: string
  keyFor?: (item: T, index: number) => string | number
}) {
  const parentRef = useRef<HTMLDivElement | null>(null)
  const shouldVirtualize = items.length >= VIRTUALIZATION_THRESHOLD

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimatedRowHeight + gapPx,
    overscan: 6,
    enabled: shouldVirtualize,
  })

  if (!shouldVirtualize) {
    return (
      <ul
        className={cn('flex flex-col', className)}
        style={{ gap: gapPx }}
      >
        {items.map((item, i) => (
          <li key={keyFor?.(item, i) ?? i}>{renderItem(item, i)}</li>
        ))}
      </ul>
    )
  }

  const virtualItems = virtualizer.getVirtualItems()
  return (
    <div
      ref={parentRef}
      className={cn('overflow-y-auto -mx-1 px-1', maxHeightClassName, className)}
    >
      <div
        role="list"
        style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
      >
        {virtualItems.map((v) => {
          const item = items[v.index]
          return (
            <div
              key={keyFor?.(item, v.index) ?? v.index}
              role="listitem"
              ref={virtualizer.measureElement}
              data-index={v.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${v.start}px)`,
                paddingBottom: gapPx,
              }}
            >
              {renderItem(item, v.index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
