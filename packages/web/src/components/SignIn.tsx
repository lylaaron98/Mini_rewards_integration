import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { ApiError, fetchUsers, login, registerAccount } from '../lib/api'
import type { UserSummary } from '../lib/api'

/**
 * Sign in, or create an account.
 *
 * One component with two modes rather than two screens: the fields overlap
 * almost entirely, and someone who tried to sign in and discovered they have no
 * account should not lose what they typed to get to the other form.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (user: UserSummary) => void }) {
  const [mode, setMode] = useState<'signin' | 'register'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')

  const demoUsers = useQuery({ queryKey: ['demo-users'], queryFn: fetchUsers })

  const submit = useMutation({
    mutationFn: () =>
      mode === 'signin'
        ? login(email, password)
        : registerAccount({ email, password, displayName }),
    onSuccess: onSignedIn,
  })

  const error = submit.error

  return (
    <div className="mx-auto max-w-md">
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-xl font-semibold tracking-tight">
          {mode === 'signin' ? 'Sign in' : 'Create an account'}
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {mode === 'signin'
            ? 'Your balance, rewards and history are tied to your account.'
            : 'A new account starts at zero points until partner activity arrives for it.'}
        </p>

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit.mutate()
          }}
        >
          {mode === 'register' && (
            <Field
              id="displayName"
              label="Name"
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={setDisplayName}
              required
            />
          )}

          <Field
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            required
          />

          <Field
            id="password"
            label="Password"
            type="password"
            /*
              Telling the browser's password manager which form this is. Without
              it, a manager offers to save the wrong thing, or nothing at all —
              and a user who cannot save their password picks a worse one.
            */
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            value={password}
            onChange={setPassword}
            required
            hint={mode === 'register' ? 'At least 8 characters.' : undefined}
          />

          {error && (
            <p
              /*
                role="alert" so a screen reader announces the failure. A sighted
                user sees red appear; without this, someone using a screen reader
                submits the form and hears nothing at all.
              */
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
            >
              {describeAuthError(error)}
            </p>
          )}

          <button
            type="submit"
            disabled={submit.isPending}
            className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            {submit.isPending
              ? mode === 'signin'
                ? 'Signing in…'
                : 'Creating account…'
              : mode === 'signin'
                ? 'Sign in'
                : 'Create account'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-slate-600 dark:text-slate-400">
          {mode === 'signin' ? 'No account yet?' : 'Already have an account?'}{' '}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'signin' ? 'register' : 'signin')
              submit.reset()
            }}
            className="font-medium text-slate-900 underline underline-offset-2 dark:text-slate-100"
          >
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </div>

      {/*
        The demo accounts, listed where they are needed rather than in a README a
        reviewer has to go and find. Seed data for a local database, and labelled
        as such.
      */}
      {demoUsers.data && demoUsers.data.length > 0 && (
        <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Demo accounts</p>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            Seeded for local development. Password <Code>{DEMO_PASSWORD}</Code> for all of them.
          </p>

          <ul className="mt-3 space-y-1">
            {demoUsers.data
              .filter((user) => user.email !== null)
              .map((user) => (
                <li key={user.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-slate-700 dark:text-slate-300">
                    {user.displayName}
                    <span className="text-slate-500 dark:text-slate-400"> · {user.email}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('signin')
                      setEmail(user.email ?? '')
                      setPassword(DEMO_PASSWORD)
                      submit.reset()
                    }}
                    className="shrink-0 rounded border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-600 transition hover:bg-white dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    Use
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * Matches the seed. Local development credentials, and stated as such right
 * beside the list so nobody mistakes them for anything else.
 */
const DEMO_PASSWORD = 'demo1234'

function describeAuthError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Could not reach the server. Check your connection and try again.'
  }

  switch (error.code) {
    case 'invalid_credentials':
      // Deliberately the same message the API gives, which does not say whether
      // the account exists. Being more helpful here would be a way to enumerate
      // who has an account.
      return 'Email or password is incorrect.'
    case 'email_taken':
      return 'That email already has an account. Sign in instead.'
    case 'rate_limited':
      return 'Too many attempts. Wait a minute and try again.'
    default:
      return error.message
  }
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  required,
  hint,
}: {
  id: string
  label: string
  type: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
  required?: boolean
  hint?: string
}) {
  return (
    <div>
      {/* A real <label>, not a placeholder. A placeholder disappears the moment
          you type, leaving the field unlabelled for everyone and invisible to a
          screen reader. */}
      <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
      />
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  )
}

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-xs dark:bg-slate-800">
      {children}
    </code>
  )
}
