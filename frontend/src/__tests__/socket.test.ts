import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { connectWorkspaceSocket } from '@/lib/socket'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  readyState: number = 0 // CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  static readonly OPEN = 1
  static readonly CLOSED = 3

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    if (this.onclose) this.onclose()
  }

  // Helper to trigger open
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    if (this.onopen) this.onopen()
  }

  // Helper to trigger message
  simulateMessage(data: object) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) })
  }
}

describe('connectWorkspaceSocket', () => {
  const origWS = globalThis.WebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    ;(globalThis as any).WebSocket = MockWebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = origWS
  })

  it('connects, notifies state, and sends pings periodically', () => {
    const states: boolean[] = []
    const events: any[] = []

    const client = connectWorkspaceSocket(
      'ws-123',
      (e) => events.push(e),
      (st) => states.push(st)
    )

    expect(MockWebSocket.instances.length).toBe(1)
    const ws = MockWebSocket.instances[0]
    expect(ws.url).toContain('/ws/workspaces/ws-123')

    // Simulate open
    ws.simulateOpen()
    expect(states).toEqual([true])

    // Advance 25 seconds -> ping sent
    vi.advanceTimersByTime(25000)
    expect(ws.sent).toContain(JSON.stringify({ type: 'ping' }))

    // Simulate message
    ws.simulateMessage({ type: 'hello', workspace_id: 'ws-123' })
    expect(events).toEqual([{ type: 'hello', workspace_id: 'ws-123' }])

    client.close()
    expect(ws.readyState).toBe(MockWebSocket.CLOSED)
  })

  it('reconnects with exponential backoff on close', () => {
    const states: boolean[] = []
    const client = connectWorkspaceSocket('ws-123', () => {}, (st) => states.push(st))

    const ws1 = MockWebSocket.instances[0]
    ws1.simulateOpen()
    expect(states).toEqual([true])

    // Disconnect ws1
    ws1.close()
    expect(states).toEqual([true, false])

    // First reconnect attempt: 400 * 2^1 = 800 ms
    vi.advanceTimersByTime(790)
    expect(MockWebSocket.instances.length).toBe(1)

    vi.advanceTimersByTime(20)
    expect(MockWebSocket.instances.length).toBe(2)

    client.close()
  })
})
