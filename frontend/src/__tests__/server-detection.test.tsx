import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerStatusBar } from '@/components/ServerStatusBar'
import { ServerConnectSteps } from '@/components/ServerConnectSteps'
import { useServer, startServerWatch } from '@/lib/server'

const originalFetch = globalThis.fetch
const originalVisibilityState = document.visibilityState

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  Object.defineProperty(document, 'visibilityState', {
    value: originalVisibilityState,
    configurable: true,
    writable: true,
  })
  vi.restoreAllMocks()
})

describe('Server Detection and Classification', () => {
  it('a) ping ok + origin_allowed true -> connected; ping ok + origin_allowed false -> blocked-origin with copy block', async () => {
    // 1. origin_allowed true
    const pingOk = {
      app: 'nexmind',
      ok: true,
      version: '1.2.0',
      origin_allowed: true,
      origin: 'https://nexmind.vercel.app',
    }
    const healthOk = {
      app: 'nexmind',
      status: 'ok',
      version: '1.2.0',
      capabilities: { local_paths: true, git_token: true },
    }

    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/ping')) {
        return new Response(JSON.stringify(pingOk), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/health')) {
        return new Response(JSON.stringify(healthOk), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    })

    useServer.setState({ state: 'not-running', status: 'checking', connected: false })
    const ok1 = await useServer.getState().check()
    expect(ok1).toBe(true)
    expect(useServer.getState().state).toBe('connected')
    expect(useServer.getState().status).toBe('online')

    // 2. origin_allowed false
    const pingDisallowed = {
      app: 'nexmind',
      ok: true,
      version: '1.2.0',
      origin_allowed: false,
      origin: 'https://disallowed-preview.vercel.app',
    }
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/ping')) {
        return new Response(JSON.stringify(pingDisallowed), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    })

    useServer.setState({ state: 'connected', status: 'online', connected: true })
    const ok2 = await useServer.getState().check()
    expect(ok2).toBe(false)
    expect(useServer.getState().state).toBe('blocked-origin')
    expect(useServer.getState().blockedOrigin).toBe('https://disallowed-preview.vercel.app')

    // Render ServerStatusBar
    const { unmount } = render(<ServerStatusBar />)
    expect(screen.getByText("Server found, but it doesn't allow this site yet")).toBeTruthy()
    expect(
      screen.getByText(/NEXMIND_CORS_ORIGINS=https:\/\/disallowed-preview\.vercel\.app/)
    ).toBeTruthy()
    unmount()
  })

  it('b) CORS fetch rejects but no-cors fetch resolves -> blocked-browser with [Allow access] button; clicking re-probes with targetAddressSpace', async () => {
    const fetchCalls: { url: string; init?: RequestInit }[] = []

    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      fetchCalls.push({ url, init })
      if (init?.mode === 'no-cors') {
        // Opaque response resolves
        return new Response('', { status: 200 })
      }
      throw new TypeError('Failed to fetch')
    })

    useServer.setState({ state: 'not-running', status: 'checking', connected: false })
    const ok = await useServer.getState().check()
    expect(ok).toBe(false)
    expect(useServer.getState().state).toBe('blocked-browser')

    render(<ServerStatusBar />)
    expect(screen.getByText('Server found, but your browser is blocking this page')).toBeTruthy()
    const allowBtn = screen.getByRole('button', { name: /Allow access/i })
    expect(allowBtn).toBeTruthy()

    // Enable targetAddressSpace support on Request.prototype
    Object.defineProperty(Request.prototype, 'targetAddressSpace', {
      value: 'local',
      configurable: true,
      writable: true,
    })

    fetchCalls.length = 0

    // Click Allow access
    await act(async () => {
      fireEvent.click(allowBtn)
    })

    // Assert fetch options include targetAddressSpace: 'local'
    const callWithLocal = fetchCalls.find(
      (c) => (c.init as any)?.targetAddressSpace === 'local'
    )
    expect(callWithLocal).toBeTruthy()
    expect((callWithLocal?.init as any)?.targetAddressSpace).toBe('local')
  })

  it('c) Both reject -> not-running; 404 on ping + health ok -> connected; non-nexmind JSON -> other-app', async () => {
    // 1. Both reject
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new TypeError('Network error')
    })

    useServer.setState({ state: 'connected', status: 'online', connected: true })
    const ok1 = await useServer.getState().check()
    expect(ok1).toBe(false)
    expect(useServer.getState().state).toBe('not-running')

    const { unmount: u1 } = render(<ServerStatusBar />)
    expect(screen.getByText('Server not running')).toBeTruthy()
    u1()

    // 2. 404 on ping + health ok -> connected
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/ping')) {
        return new Response('Not found', { status: 404 })
      }
      if (url.includes('/api/health')) {
        return new Response(
          JSON.stringify({
            app: 'nexmind',
            status: 'ok',
            version: '1.0.0',
            capabilities: { local_paths: true, git_token: true },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response(JSON.stringify({}), { status: 200 })
    })

    useServer.setState({ state: 'not-running', status: 'offline', connected: false })
    const ok2 = await useServer.getState().check()
    expect(ok2).toBe(true)
    expect(useServer.getState().state).toBe('connected')

    // 3. non-nexmind JSON -> other-app
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ app: 'some-other-service', ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    useServer.setState({ state: 'connected', status: 'online', connected: true })
    const ok3 = await useServer.getState().check()
    expect(ok3).toBe(false)
    expect(useServer.getState().state).toBe('other-app')

    const { unmount: u3 } = render(<ServerStatusBar />)
    expect(screen.getByText('Something else is using this address')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Try another port/i })).toBeTruthy()
    u3()
  })

  it('d) status bar text matches each state; Open NexMind becomes visible button after 10 s', () => {
    vi.useFakeTimers()

    const states = [
      { state: 'not-running', text: 'Server not running', action: /Show me how/i },
      { state: 'blocked-browser', text: 'Server found, but your browser is blocking this page', action: /Allow access/i },
      { state: 'blocked-origin', text: "Server found, but it doesn't allow this site yet", action: /How to fix/i },
      { state: 'outdated', text: 'Your NexMind server is out of date', action: /How to update/i },
      { state: 'other-app', text: 'Something else is using this address', action: /Try another port/i },
      { state: 'connected', text: 'Server connected', action: null },
    ] as const

    for (const item of states) {
      useServer.setState({
        state: item.state,
        status: item.state === 'connected' ? 'online' : 'offline',
        connected: item.state === 'connected',
        blockedOrigin: 'https://test.vercel.app',
      })
      const { unmount } = render(<ServerStatusBar />)
      expect(screen.getByText(item.text)).toBeTruthy()
      if (item.action) {
        expect(screen.getByRole('button', { name: item.action })).toBeTruthy()
      }
      unmount()
    }

    // 10s button transition test
    useServer.setState({
      state: 'not-running',
      status: 'offline',
      connected: false,
    })

    const { unmount } = render(<ServerStatusBar />)

    // Initially: link, not button
    const link = screen.getByText('Open NexMind on this computer')
    expect(link.tagName).toBe('A')
    expect(screen.queryByRole('button', { name: /Open NexMind on this computer/i })).toBeNull()

    // Advance timer by 10s
    act(() => {
      vi.advanceTimersByTime(10000)
    })

    // Now has role="button"
    const button = screen.getByRole('button', { name: /Open NexMind on this computer/i })
    expect(button).toBeTruthy()
    expect(button.getAttribute('href')).toBe('http://127.0.0.1:8000/app')

    unmount()
    vi.useRealTimers()
  })

  it('e) background polling pauses while document.visibilityState is hidden and uses slower interval when connected', async () => {
    vi.useFakeTimers()

    let isOnline = false
    const checkMock = vi.fn().mockImplementation(async () => isOnline)
    useServer.setState({
      check: checkMock,
      status: 'offline',
      connected: false,
    })

    // Start watching
    const stop = startServerWatch()

    // First loop run immediately: check called once
    expect(checkMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      await Promise.resolve()
    })

    // When offline (isOnline = false), interval is 1500ms
    await act(async () => {
      vi.advanceTimersByTime(1499)
      await Promise.resolve()
    })
    expect(checkMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(checkMock).toHaveBeenCalledTimes(2)

    // Now let check succeed (connected)
    isOnline = true
    await act(async () => {
      vi.advanceTimersByTime(1500)
      await Promise.resolve()
    })
    expect(checkMock).toHaveBeenCalledTimes(3)

    // When connected (isOnline = true), interval is 15000ms (slower)
    await act(async () => {
      vi.advanceTimersByTime(1500)
      await Promise.resolve()
    })
    // Should NOT have run again after only 1500ms
    expect(checkMock).toHaveBeenCalledTimes(3)

    // Advance to 15000ms
    await act(async () => {
      vi.advanceTimersByTime(13500)
      await Promise.resolve()
    })
    expect(checkMock).toHaveBeenCalledTimes(4)

    // Now test visibilityState: hidden
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
      writable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))

    // Advance time while hidden: check should NOT be called
    await act(async () => {
      vi.advanceTimersByTime(30000)
      await Promise.resolve()
    })
    expect(checkMock).toHaveBeenCalledTimes(4)

    // Restore visibility
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
      writable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))

    // Immediately upon becoming visible, it should resume
    expect(checkMock).toHaveBeenCalledTimes(5)

    stop()
    vi.useRealTimers()
  })
})
