/**
 * Full-stack check against a running hosted (Vercel-mode) NexMind:
 *   NEXMIND_LIVE_API=https://your-site.vercel.app npx vitest run src/__tests__/hosted.live.test.ts
 * Skipped unless NEXMIND_LIVE_API is set. Uses the real frontend modules (no mocks).
 */
import { File as NodeFile } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import JSZipLike from './helpers/zip'
import { api, streamChat, uploadFiles } from '@/lib/api'
import { connectWorkspaceSocket } from '@/lib/socket'

const LIVE = process.env.NEXMIND_LIVE_API

describe.skipIf(!LIVE)('hosted NexMind, real backend', () => {
  it('creates a project, uploads in chunks, builds via the event feed, queries and chats', async () => {
    localStorage.setItem('nexmind.api.v2', LIVE!)
    const ws = await api.createWorkspace('Live check', '', 'code')
    const files: Record<string, Uint8Array | string> = {
      'shop/auth.py': 'def validate_token(t):\n    return t.startswith("tok_")\n\ndef login(u, p):\n    return validate_token("tok_" + u)\n',
      'shop/api.py': 'from .auth import login\n\ndef login_handler(req):\n    return login(req["u"], req["p"])\n',
      'shop/README.md': '# Shop\nUse `login` and `validate_token`.\n',
      'shop/blob.txt': 'x'.repeat(5_000_000), // > one 3.5 MB chunk
    }
    // Node's File (jsdom's Blob cannot be sent by Node's fetch; real browsers are unaffected)
    const zip = new NodeFile([JSZipLike(files) as unknown as ArrayBuffer], 'shop.zip', { type: 'application/zip' }) as unknown as File
    const progress: number[] = []
    const { job_id } = await uploadFiles(ws.id, [zip], (p) => progress.push(p))
    expect(job_id).toMatch(/^job_/)
    expect(progress.at(-1)).toBe(100)

    const types: string[] = []
    const sock = connectWorkspaceSocket(ws.id, (e) => types.push(e.type))
    const t0 = Date.now()
    while (!types.includes('job_done') && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 300))
    sock.close()
    expect(types[0]).toBe('hello')
    expect(types).toContain('graph_stream_start')
    expect(types).toContain('graph_batch')
    expect(types).toContain('job_done')

    const g = await api.graph(ws.id)
    expect(g.nodes.length).toBeGreaterThan(5)
    const s = await api.search(ws.id, 'validate_token')
    const node = s.nodes.find((n) => n.label === 'validate_token')!
    const d = await api.node(ws.id, node.id)
    expect(d.code?.text).toContain('def validate_token')

    const t = await api.createThread(ws.id)
    let done = ''
    await streamChat(ws.id, t.id, 'How does login work?', { onDone: (x) => { done = x.answer } })
    expect(done.length).toBeGreaterThan(10)

    // another browser (different key) cannot see this workspace
    const mine = localStorage.getItem('nexmind.key')!
    localStorage.setItem('nexmind.key', 'f'.repeat(32))
    api.clearCache()
    await expect(api.workspace(ws.id)).rejects.toMatchObject({ status: 404 })
    localStorage.setItem('nexmind.key', mine)
    await api.deleteWorkspace(ws.id)
  }, 180000)
})
