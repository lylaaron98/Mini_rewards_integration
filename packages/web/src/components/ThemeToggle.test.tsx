import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ThemeToggle } from './ThemeToggle'
import { useTheme } from '../lib/use-theme'

/**
 * The theme toggle, driven through the hook that owns the DOM class.
 *
 * Asserting on `documentElement.classList` rather than on rendered colours,
 * because the class is the actual contract: Tailwind's `dark:` variants key off
 * it, and a toggle that updates React state without touching the class would
 * look correct in a snapshot and change nothing on screen.
 */

function Harness() {
  const { theme, toggle } = useTheme()
  return (
    <>
      <ThemeToggle theme={theme} onToggle={toggle} />
      <span data-testid="theme">{theme}</span>
    </>
  )
}

beforeEach(() => {
  document.documentElement.classList.remove('dark')
  window.localStorage.clear()
})

afterEach(() => {
  document.documentElement.classList.remove('dark')
  window.localStorage.clear()
})

describe('the theme toggle', () => {
  it('starts from the class already on the document', () => {
    document.documentElement.classList.add('dark')

    render(<Harness />)

    expect(screen.getByTestId('theme')).toHaveTextContent('dark')
  })

  it('switches the document class when pressed', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    expect(document.documentElement).not.toHaveClass('dark')

    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }))

    expect(document.documentElement).toHaveClass('dark')
    expect(screen.getByTestId('theme')).toHaveTextContent('dark')

    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }))

    expect(document.documentElement).not.toHaveClass('dark')
  })

  /**
   * Persistence is what makes the choice a preference rather than a gesture.
   * The inline script in index.html reads this key before the first paint.
   */
  it('remembers the choice', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }))

    expect(window.localStorage.getItem('mini-rewards.theme')).toBe('dark')
  })

  /**
   * Labelled by the action rather than the state. A screen reader user hearing
   * the current state has to work out what pressing it would do.
   */
  it('names the action it will perform, not the state it is in', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }))

    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument()
  })
})
