/**
 * Skeletons, not spinners.
 *
 * A spinner says "something is happening"; a skeleton says "something is
 * happening, and here is the shape it will take". The layout does not jump when
 * the data lands, and the eye has already found where the number will be — which
 * on a screen whose main element is a balance is most of the perceived speed.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`motion-safe:animate-[skeleton-pulse_1.6s_ease-in-out_infinite] rounded bg-slate-200 dark:bg-slate-800 ${className}`}
      // Decorative: the surrounding region is already marked aria-busy, so
      // announcing each grey block would be noise.
      aria-hidden="true"
    />
  )
}

export function SkeletonRows({ rows, className = '' }: { rows: number; className?: string }) {
  return (
    <div className={className}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-4 py-3">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  )
}
