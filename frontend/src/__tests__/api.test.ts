import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { formatApiError, ApiError, streamChat } from '@/lib/api'

describe('api client and error formatting', () => {
  it('formats status 413 as too large', () => {
    const err = new ApiError('Payload too large', 413)
    expect(formatApiError(err)).toBe('That file is too large.')
  })

  it('formats 5xx status without showing raw server details', () => {
    const err = new ApiError('Internal Server Error: traceback details...', 500)
    expect(formatApiError(err)).toBe('The server hit a problem. Try again; details are in the server terminal.')

    const err502 = new ApiError('Bad Gateway', 502)
    expect(formatApiError(err502)).toBe('The server hit a problem. Try again; details are in the server terminal.')
  })

  it('formats FastAPI 422 validation array into readable field message', () => {
    const err = new ApiError('Unprocessable Entity', 422, [
      { loc: ['body', 'name'], msg: 'String should have at least 1 character' },
    ])
    expect(formatApiError(err)).toBe('name: String should have at least 1 character')
  })

  it('formats FastAPI 422 array mentioning kind into friendly version message', () => {
    const err = new ApiError('Unprocessable Entity', 422, [
      { loc: ['body', 'kind'], msg: "Input should be 'code' or 'docs'" },
    ])
    expect(formatApiError(err)).toBe('The workspace type is not supported by this server version. Restart the backend after updating.')
  })

  it('formats object detail or message', () => {
    const errObj = new ApiError('Bad Request', 400, { detail: 'Cannot delete active workspace' })
    expect(formatApiError(errObj)).toBe('Cannot delete active workspace')

    const errMsg = new ApiError('Bad Request', 400, { message: 'Invalid token' })
    expect(formatApiError(errMsg)).toBe('Invalid token')

    const errKeyVal = new ApiError('Bad Request', 400, { reason: 'quota_exceeded' })
    expect(formatApiError(errKeyVal)).toBe('reason: quota_exceeded')
  })

  it('handles JSON string in detail', () => {
    const jsonStr = JSON.stringify([{ loc: ['body', 'title'], msg: 'Title is required' }])
    const err = new ApiError(jsonStr, 422, jsonStr)
    expect(formatApiError(err)).toBe('title: Title is required')
  })

  it('formats network failure / Cannot reach message', () => {
    expect(formatApiError(new Error('Failed to fetch'))).toBe('Cannot reach the NexMind server. Is it running?')
    expect(formatApiError(new Error('NetworkError when attempting to fetch resource.'))).toBe('Cannot reach the NexMind server. Is it running?')
    expect(formatApiError(new Error('Cannot reach server'))).toBe('Cannot reach the NexMind server. Is it running?')
  })

  it('formats null or undefined error with fallback', () => {
    expect(formatApiError(null)).toBe('An unexpected error occurred.')
    expect(formatApiError(undefined)).toBe('An unexpected error occurred.')
  })
})

describe('SSE streamChat parser', () => {
  const origFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('parses split chunks and dispatches start, retrieval, token, error, done events in order', async () => {
    const events: string[] = []
    let receivedTokens = ''
    let finalAnswer = ''

    const chunks = [
      'event: start\ndata: {}\n\n',
      'event: retrieval\ndata: {"nodes": [], "citations": []}\n\n',
      'event: token\ndata: {"text": "Hel',
      'lo "}\n\nevent: token\ndata: {"text": "world!"}\n\n',
      'event: done\ndata: {"answer": "Hello world!", "citations": [], "followups": [], "provider": "mock"}\n\n',
    ]

    const encoder = new TextEncoder()
    let chunkIdx = 0
    const stream = new ReadableStream({
      pull(controller) {
        if (chunkIdx < chunks.length) {
          controller.enqueue(encoder.encode(chunks[chunkIdx++]))
        } else {
          controller.close()
        }
      },
    })

    globalThis.fetch = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }))

    await streamChat('ws-test', 'th-test', 'hi', {
      onStart: () => events.push('start'),
      onRetrieval: () => events.push('retrieval'),
      onToken: (t) => {
        events.push('token')
        receivedTokens += t
      },
      onDone: (d) => {
        events.push('done')
        finalAnswer = d.answer
      },
      onError: (msg) => events.push(`error: ${msg}`),
    })

    expect(events).toEqual(['start', 'retrieval', 'token', 'token', 'done'])
    expect(receivedTokens).toBe('Hello world!')
    expect(finalAnswer).toBe('Hello world!')
  })

  it('handles abort signal without throwing', async () => {
    const ctl = new AbortController()
    ctl.abort()

    globalThis.fetch = vi.fn().mockImplementation(() => {
      const err = new Error('AbortError')
      err.name = 'AbortError'
      throw err
    })

    await expect(streamChat('ws-test', 'th-test', 'hi', {}, ctl.signal)).resolves.not.toThrow()
  })
})
