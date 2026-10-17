/**
 * Wiring test: renders the real UI against a REAL NexMind server (only the WebGL layer is mocked).
 * Start the backend first:   cd ../backend && python -m nexmind serve --port 8000
 * Then:                      npm test
 * It is skipped automatically when no server answers.
 */
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const calls: Record<string, number> = {}
vi.mock('@/three/engine', () => {
  const handler = (name: string) => (...args: unknown[]) => {
    calls[name] = (calls[name] ?? 0) + 1
    if (name === 'getPointer') return { x: 100, y: 100 }
    if (name === 'hasNode') return false
    void args
    return undefined
  }
  class BrainEngine {
    constructor() {
      return new Proxy(this, { get: (t, k: string) => (k === 'then' ? undefined : handler(k)) })
    }
  }
  return { BrainEngine, NODE_COLORS: {}, EDGE_COLORS: {}, BG: '#000' }
})

import App from '@/App'
import { useView } from '@/lib/store'

const BASE = (process.env.NEXMIND_TEST_API as string | undefined) ?? 'http://127.0.0.1:8000'
const SAMPLE = process.env.NEXMIND_TEST_SAMPLE as string | undefined
let online = false
const errors: string[] = []

beforeAll(async () => {
  try { online = (await (await fetch(BASE + '/api/health')).json()).app === 'nexmind' } catch { online = false }
  localStorage.setItem('nexmind.api', BASE)
  const orig = console.error
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.map(String).join(' ')); void orig })
})
afterAll(() => cleanup())

describe.skipIf(!process.env.NEXMIND_TEST_SAMPLE)('UI against a live backend', () => {
  it('connects, analyzes a local folder, inspects a node, runs impact and chats', async () => {
    expect(online, `no NexMind server at ${BASE}`).toBe(true)
    render(<MemoryRouter initialEntries={['/app']}><App /></MemoryRouter>)

    // 1. connect screen finds the server on its own, then releases into the hub
    await screen.findByText(/Connected to NexMind/i, {}, { timeout: 10000 })
    await screen.findByRole('heading', { name: /Analyze your first repository|^Workspaces$/i }, { timeout: 10000 })

    // 2. analyze a local folder through the real form
    fireEvent.click(await screen.findByRole('tab', { name: /Local folder/i }))
    fireEvent.change(screen.getByPlaceholderText(/C:\\Users/i), { target: { value: SAMPLE } })
    fireEvent.click(screen.getByRole('button', { name: /Analyze/i }))

    // 3. the workspace opens and the graph arrives (socket stream or REST fallback)
    await waitFor(() => expect(useView.getState().nodes.length).toBeGreaterThan(20), { timeout: 40000, interval: 500 })
    expect(calls.addBatch ?? calls.setData).toBeGreaterThan(0)

    // 4. search -> select -> drawer shows real details
    const search = await screen.findByLabelText(/Search the graph/i)
    fireEvent.change(search, { target: { value: 'validate_token' } })
    const hit = await screen.findByRole('button', { name: /^Function\s*validate_token/ }, { timeout: 10000 })
    fireEvent.click(hit)
    const drawer = await screen.findByLabelText('Details', {}, { timeout: 10000 })
    await within(drawer).findByRole('heading', { name: 'validate_token' }, { timeout: 10000 })
    expect(calls.flyTo).toBeGreaterThan(0)

    // 5. impact analysis button
    fireEvent.click(within(drawer).getByRole('button', { name: /What depends on it/i }))
    const card = await screen.findByLabelText('Impact analysis', {}, { timeout: 10000 })
    expect(within(card).getByText(/LOW|MEDIUM|HIGH|CRITICAL/)).toBeTruthy()
    expect(calls.shockwave).toBeGreaterThan(0)

    // 6. chat streams an answer and fires the graph activation
    const box = screen.getByLabelText('Message')
    fireEvent.change(box, { target: { value: 'How does login work?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(calls.ripple).toBeGreaterThan(0), { timeout: 30000 })
    expect((await screen.findAllByText(/Answered offline|login/i, {}, { timeout: 30000 })).length).toBeGreaterThan(1)

    // 7. side panels render with real data
    fireEvent.click(screen.getByRole('button', { name: 'Flows' }))
    await screen.findByText(/Execution flows/i)
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }))
    await screen.findByText(/^Insights$/)
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }))
    await screen.findByText(/messages/i)

    const bad = errors.filter((e) => /Maximum update depth|getSnapshot|not wrapped in act|Cannot update a component|Each child in a list|uncaught/i.test(e) && !/not wrapped in act/.test(e))
    expect(bad, bad.join('\n')).toEqual([])
  })
})
