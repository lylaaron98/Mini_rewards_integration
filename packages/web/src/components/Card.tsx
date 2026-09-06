import { useId } from 'react'
import type { ReactNode } from 'react'

/**
 * A titled panel.
 *
 * Written for the developer page, where four unrelated tools — a signer, an
 * allocator, a delivery log and a reconciliation check — used to run together
 * down one column separated by nothing but whitespace. Whitespace is a weak
 * boundary: it tells you two things are apart without telling you where one ends,
 * and on a page of controls that matters, because "which section does this button
 * belong to" is a question with a wrong answer.
 *
 * `<section>` with an accessible name rather than a `<div>`, which makes each card
 * a landmark a screen reader can jump between — the same navigation the borders
 * give someone who can see them. The heading is a real `<h3>` under the page's
 * `<h2>`, so the outline stays walkable rather than being a wall of same-level
 * boxes.
 */
export function Card({
  title,
  description,
  children,
  className = '',
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  /** Extra classes for the section itself — spacing, span, and nothing else. */
  className?: string
}) {
  // Generated rather than derived from the title: two cards could be titled the
  // same, and a duplicate id silently points aria-labelledby at whichever came
  // first.
  const headingId = useId()

  return (
    <section
      aria-labelledby={headingId}
      className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      <h3
        id={headingId}
        className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
      >
        {title}
      </h3>

      {description && (
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{description}</p>
      )}

      <div className="mt-4">{children}</div>
    </section>
  )
}
