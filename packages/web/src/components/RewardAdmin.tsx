import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { allocateReward, createReward, fetchRewards, fetchUsers } from '../lib/api'
import type { AllocationResult, ApiError } from '../lib/api'
import { ApiError as ApiErrorClass } from '../lib/api'
import { formatPoints } from '../lib/format'
import { useToast } from '../lib/toast'
import { Card } from './Card'

/**
 * Creating rewards and allocating them, for administrators.
 *
 * An allocation is two real ledger entries — an ADJUSTMENT credit for the
 * reward's cost, then the ordinary redemption that spends it — so the recipient
 * ends up holding the reward with their balance unchanged, and both rows show up
 * in their own history. Nothing about it is special-cased on the server, which
 * is why it can be trusted: an admin grant travels the same path as any other
 * redemption.
 */

/**
 * One-click presets.
 *
 * Each creates the reward if its SKU is not already in the catalogue and then
 * allocates it to whoever is selected. They exist because the interesting thing
 * to demonstrate is the allocation, not typing four fields to get there — and
 * because a preset with a fixed SKU is idempotent across clicks by construction:
 * the second press finds the reward already there and simply allocates again.
 */
const MACROS = [
  {
    label: 'Coffee (250)',
    sku: 'MACRO-COFFEE',
    name: 'Coffee Voucher',
    description: 'One free coffee at any participating café.',
    costPoints: 250,
    stock: 100,
  },
  {
    label: 'Tote bag (750)',
    sku: 'MACRO-TOTE',
    name: 'Canvas Tote Bag',
    description: 'Heavyweight cotton tote with the partner logo.',
    costPoints: 750,
    stock: 50,
  },
  {
    label: 'Wallpapers (50)',
    sku: 'MACRO-WALLPAPER',
    name: 'Digital Wallpaper Pack',
    description: 'A set of twelve desktop and phone wallpapers.',
    costPoints: 50,
    // Unlimited, so repeated macro runs never exhaust it — the one preset that
    // can always be allocated regardless of how much a reviewer clicks.
    stock: null as number | null,
  },
  {
    label: 'Headphones (5,000)',
    sku: 'MACRO-HEADPHONES',
    name: 'Wireless Headphones',
    description: 'Over-ear noise-cancelling headphones.',
    costPoints: 5_000,
    // Deliberately scarce: allocate to more people than there are units and the
    // out-of-stock path reports per-user failures rather than one vague error.
    stock: 2,
  },
]

export function RewardAdmin() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const users = useQuery({ queryKey: ['demo-users'], queryFn: fetchUsers })
  const rewards = useQuery({ queryKey: ['rewards'], queryFn: fetchRewards })

  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [rewardId, setRewardId] = useState('')
  const [lastResult, setLastResult] = useState<AllocationResult | null>(null)

  const toggleUser = (id: string) =>
    setSelectedUserIds((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    )

  const report = (result: AllocationResult) => {
    setLastResult(result)

    // A partial success is the interesting case, and a single "done" would hide
    // it. The counts say what happened; the per-user list below says to whom.
    toast({
      tone: result.failed === 0 ? 'success' : 'error',
      title:
        result.failed === 0
          ? `Allocated to ${result.allocated} ${result.allocated === 1 ? 'user' : 'users'}`
          : `${result.allocated} allocated, ${result.failed} failed`,
      detail:
        result.failed === 0
          ? 'Credited and redeemed on their behalf; balances are unchanged.'
          : 'Failures are listed below with the reason for each.',
    })

    void queryClient.invalidateQueries()
  }

  const allocate = useMutation({
    mutationFn: (targetRewardId: string) =>
      allocateReward({
        rewardId: targetRewardId,
        userIds: selectedUserIds,
        /**
         * One key per attempt, minted here at the moment of the click. Both
         * halves of the allocation derive their idempotency from it, so a
         * double-click allocates once.
         */
        allocationKey: crypto.randomUUID(),
      }),
    onSuccess: report,
    onError: (error: unknown) => {
      toast({
        tone: 'error',
        title: 'Allocation failed',
        detail: error instanceof Error ? error.message : 'Unknown error',
      })
    },
  })

  /**
   * Create-if-missing, then allocate.
   *
   * A 409 means the reward already exists, which for a preset is the expected
   * second press rather than a failure — so it is caught and the existing
   * catalogue entry is used. Any other error is real and propagates.
   */
  const runMacro = useMutation({
    mutationFn: async (macro: (typeof MACROS)[number]) => {
      let target = rewards.data?.find((reward) => reward.sku === macro.sku)

      if (!target) {
        try {
          target = await createReward(macro)
        } catch (error) {
          if (!(error instanceof ApiErrorClass) || error.code !== 'sku_taken') throw error

          const refreshed = await queryClient.fetchQuery({
            queryKey: ['rewards'],
            queryFn: fetchRewards,
          })
          target = refreshed.find((reward) => reward.sku === macro.sku)
        }
      }

      if (!target) throw new Error(`Could not find or create ${macro.sku}`)

      return allocateReward({
        rewardId: target.id,
        userIds: selectedUserIds,
        allocationKey: crypto.randomUUID(),
      })
    },
    onSuccess: report,
    onError: (error: unknown) => {
      toast({
        tone: 'error',
        title: 'Macro failed',
        detail: error instanceof Error ? error.message : 'Unknown error',
      })
    },
  })

  const busy = allocate.isPending || runMacro.isPending
  const noneSelected = selectedUserIds.length === 0

  /*
    Two cards rather than one: allocating an existing reward and adding a new one
    to the catalogue are different jobs that happen to be done by the same
    person. Returned as a fragment so the page they sit on decides the spacing
    between them, the same as it does for every other card.
  */
  return (
    <>
      <Card
        title="Allocate rewards"
        description={
          <>
            Credits the reward&rsquo;s cost as an adjustment, then redeems it on the
            user&rsquo;s behalf. Their balance ends unchanged and both entries appear in their
            history.
          </>
        }
      >
        {/* --- who --- */}
        <fieldset>
          <legend className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Recipients
          </legend>

          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Tick as many as you like — every allocation below goes to all of them.
          </p>

          {/*
            A list of checkbox rows rather than a row of pills.

            The pills were already multi-select — real checkboxes under the
            styling — but nothing said so: a filled pill reads as the one
            selected tab in a set, so the control looked like it could hold a
            single answer while behaving like it could hold several. The
            checkbox is now visible and does that job by itself.

            Real checkboxes rather than clickable divs, as before. A checkbox is
            reachable by keyboard, announced with its state, and togglable with
            space — none of which comes free from a div with an onClick. The
            whole row is the <label>, so the hit target is the row, not the
            twelve pixels of the box.
          */}
          <ul className="mt-2 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {users.data?.map((user) => {
              const checked = selectedUserIds.includes(user.id)

              return (
                <li key={user.id}>
                  <label
                    className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition ${
                      checked
                        ? 'bg-slate-100 dark:bg-slate-800'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    {/* Accented in the theme's ink rather than left as the
                        browser's blue, which is the one colour nothing else on
                        the page uses. */}
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleUser(user.id)}
                      className="h-4 w-4 shrink-0 accent-slate-900 dark:accent-slate-100"
                    />

                    <span className="min-w-0">
                      <span className="block truncate text-slate-800 dark:text-slate-100">
                        {user.displayName}
                      </span>
                      {/* The external ref, because that is the identity the
                          partner events carry and the thing an operator is
                          actually matching against. */}
                      <span className="block truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                        {user.externalRef}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}

            {users.isPending && (
              <li className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                Loading accounts…
              </li>
            )}

            {users.data?.length === 0 && (
              <li className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                No accounts to allocate to.
              </li>
            )}
          </ul>

          <div className="mt-2 flex gap-3 text-xs">
            <button
              type="button"
              onClick={() => setSelectedUserIds(users.data?.map((user) => user.id) ?? [])}
              className="text-slate-600 underline underline-offset-2 dark:text-slate-400"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setSelectedUserIds([])}
              className="text-slate-600 underline underline-offset-2 dark:text-slate-400"
            >
              Clear
            </button>
            <span className="text-slate-500 dark:text-slate-500">
              {selectedUserIds.length} selected
            </span>
          </div>
        </fieldset>

        {/* --- macros --- */}
        <div className="mt-4">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
            One-click allocations
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Creates the reward if it is not in the catalogue yet, then allocates it.
          </p>

          <div className="mt-2 flex flex-wrap gap-2">
            {MACROS.map((macro) => (
              <button
                key={macro.sku}
                type="button"
                disabled={busy || noneSelected}
                onClick={() => runMacro.mutate(macro)}
                title={`${macro.name} — ${formatPoints(macro.costPoints)} points${
                  macro.stock === null ? ', unlimited' : `, ${macro.stock} in stock`
                }`}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {macro.label}
              </button>
            ))}
          </div>
        </div>

        {/* --- existing catalogue --- */}
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div>
            <label
              htmlFor="allocate-reward"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Or allocate an existing reward
            </label>
            <select
              id="allocate-reward"
              value={rewardId}
              onChange={(event) => setRewardId(event.target.value)}
              className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              <option value="">Choose a reward…</option>
              {rewards.data?.map((reward) => (
                <option key={reward.id} value={reward.id}>
                  {reward.name} — {formatPoints(reward.costPoints)}
                  {reward.inStock ? '' : ' (out of stock)'}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            disabled={busy || noneSelected || rewardId === ''}
            onClick={() => allocate.mutate(rewardId)}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            {busy ? 'Allocating…' : 'Allocate'}
          </button>
        </div>

        {noneSelected && (
          <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
            Select at least one recipient.
          </p>
        )}

        {/*
          Per-user outcomes, because a partial success is the normal result once
          stock runs low and a single status could only misrepresent it.
        */}
        {lastResult && (
          <ul className="mt-4 space-y-1 text-sm">
            {lastResult.outcomes.map((outcome) => (
              <li key={outcome.userId} className="flex items-start justify-between gap-3">
                <span className="text-slate-700 dark:text-slate-300">{outcome.displayName}</span>
                <span
                  className={
                    outcome.status === 'ALLOCATED'
                      ? 'shrink-0 text-emerald-700 dark:text-emerald-400'
                      : 'text-right text-red-700 dark:text-red-400'
                  }
                >
                  {outcome.status === 'ALLOCATED' ? 'allocated' : (outcome.reason ?? 'failed')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CreateReward />
    </>
  )
}

function CreateReward() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [sku, setSku] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [costPoints, setCostPoints] = useState('250')
  const [stock, setStock] = useState('')

  const create = useMutation({
    mutationFn: () =>
      createReward({
        sku,
        name,
        description,
        costPoints: Number(costPoints),
        // An empty field means unlimited, matching the nullable column rather
        // than inventing a sentinel number for it.
        stock: stock.trim() === '' ? null : Number(stock),
      }),
    onSuccess: (reward) => {
      toast({
        tone: 'success',
        title: `${reward.name} added`,
        detail: 'It is in the catalogue and available to allocate.',
      })
      setSku('')
      setName('')
      setDescription('')
      void queryClient.invalidateQueries({ queryKey: ['rewards'] })
    },
    onError: (error: unknown) => {
      const apiError = error as ApiError
      toast({
        tone: 'error',
        title: apiError.code === 'sku_taken' ? 'That SKU is taken' : 'Could not create the reward',
        detail: error instanceof Error ? error.message : 'Unknown error',
      })
    },
  })

  return (
    <Card
      title="Create a reward"
      description="Adds an entry to the catalogue. Leave stock empty for an unlimited reward."
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        <Field id="reward-sku" label="SKU" value={sku} onChange={setSku} placeholder="COFFEE-02" required />
        <Field id="reward-name" label="Name" value={name} onChange={setName} placeholder="Coffee Voucher" required />
        <Field
          id="reward-description"
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="One free coffee."
          required
          className="sm:col-span-2"
        />
        <Field
          id="reward-cost"
          label="Cost in points"
          type="number"
          value={costPoints}
          onChange={setCostPoints}
          required
        />
        <Field
          id="reward-stock"
          label="Stock"
          type="number"
          value={stock}
          onChange={setStock}
          placeholder="Leave empty for unlimited"
        />

        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {create.isPending ? 'Creating…' : 'Create reward'}
          </button>
        </div>
      </form>
    </Card>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
  className = '',
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
  required?: boolean
  className?: string
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
      />
    </div>
  )
}
