import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/three/engine', () => {
  class BrainEngine { constructor() { return new Proxy(this, { get: (_t, k: string) => (k === 'then' ? undefined : () => undefined) }) } }
  return { BrainEngine, NODE_COLORS: {}, EDGE_COLORS: {}, BG: '#000' }
})
import App from '@/App'

describe('pages that need no server', () => {
  it('landing page renders its story and links into the app', async () => {
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: /See your code and documents think/i })).toBeTruthy()
    expect(screen.getAllByRole('link', { name: /Open (the app|NexMind)/i }).length).toBeGreaterThan(0)
    expect(screen.getByText(/One command, and the page finds your server/i)).toBeTruthy()
  })

  it('shows the "Start your local server" screen when nothing is running, with copyable commands', async () => {
    localStorage.setItem('nexmind.api', 'http://127.0.0.1:59999') // nothing listens here
    render(<MemoryRouter initialEntries={['/app/w/unreachable']}><App /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: /Start your local server/i })).toBeTruthy()
    expect(await screen.findByText(/Listening for server/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Windows' }))
    expect(screen.getAllByText(/start\.ps1/).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/&&/) // PowerShell 5 cannot run "&&"
  })
})
