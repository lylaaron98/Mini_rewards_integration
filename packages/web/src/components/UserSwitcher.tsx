import type { UserSummary } from '../lib/api'

/**
 * The demo user switcher.
 *
 * Exists only because authentication is stubbed — it sets the `X-Demo-User`
 * header that stands in for a session. Real sessions delete this control rather
 * than securing it.
 *
 * A plain `<select>` rather than a custom dropdown: it is keyboard accessible,
 * screen-reader correct and native on mobile without a line of code, and none of
 * that is true of the div-based version by default.
 */
export function UserSwitcher({
  users,
  selected,
  onSelect,
}: {
  users: UserSummary[] | undefined
  selected: string | null
  onSelect: (externalRef: string) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="demo-user" className="text-sm text-slate-500">
        Acting as
      </label>

      <select
        id="demo-user"
        value={selected ?? ''}
        onChange={(event) => onSelect(event.target.value)}
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900"
      >
        <option value="" disabled>
          Choose a user…
        </option>

        {users?.map((user) => (
          <option key={user.id} value={user.externalRef}>
            {user.displayName}
          </option>
        ))}
      </select>
    </div>
  )
}
