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

  it('shows the Hub with three modes immediately when nothing is running, with server not connected chip', async () => {
    localStorage.setItem('nexmind.api', 'http://127.0.0.1:59999') // nothing listens here
    render(<MemoryRouter initialEntries={['/app']}><App /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: /Create your first workspace/i })).toBeTruthy()
    expect(screen.getByText(/Analyze a project/i)).toBeTruthy()
    expect(screen.getByText(/Study from documents/i)).toBeTruthy()
    expect(screen.getByText(/Live connect/i)).toBeTruthy()
    expect(screen.getByText(/Server not connected/i)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/&&/) // PowerShell 5 cannot run "&&"
  })
})
