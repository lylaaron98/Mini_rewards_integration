/**
 * Empty states say what to do next.
 *
 * "No transactions" is a dead end. "Earn some points by simulating partner
 * activity below" is a next step — and on a screen whose data arrives from a
 * webhook rather than from anything the user can click, that instruction is the
 * difference between a working demo and an app that looks broken.
 */
export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center dark:border-slate-700 dark:bg-slate-900">
      <p className="font-medium text-slate-900 dark:text-slate-100">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-600 dark:text-slate-400">{detail}</p>
    </div>
  )
}
