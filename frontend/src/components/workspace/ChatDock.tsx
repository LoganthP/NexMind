import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronUp, Radio, RotateCcw, SendHorizontal, Square, Sparkles } from 'lucide-react'
import { api, ApiError, streamChat } from '@/lib/api'
import { toast, useView } from '@/lib/store'
import type { ChatMessage, Citation, Retrieval } from '@/lib/types'
import { applyFocus, eng, selectNode } from '@/workspace/actions'

function inline(text: string, cites: Citation[], key: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[\d+\])/g).map((part, i) => {
    if (!part) return null
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={key + i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={key + i}>{part.slice(2, -2)}</strong>
    const m = /^\[(\d+)\]$/.exec(part)
    if (m) {
      const c = cites.find((x) => x.n === Number(m[1]))
      if (c) return (
        <button key={key + i} className="mx-0.5 inline-grid h-[1.15rem] min-w-[1.15rem] place-items-center rounded-md bg-plankton/15 px-1 align-baseline text-[0.68rem] font-semibold text-plankton hover:bg-plankton/30" title={`${c.label}${c.path ? ' · ' + c.path : ''}`}
          onMouseEnter={() => eng.current?.flash(c.node_id, 1.3)} onClick={() => selectNode(c.node_id)}>{c.n}</button>
      )
    }
    return <Fragment key={key + i}>{part}</Fragment>
  })
}

function Md({ text, cites }: { text: string; cites: Citation[] }) {
  const out: ReactNode[] = []
  let list: string[] = []
  const flush = () => { if (list.length) { out.push(<ul key={'u' + out.length}>{list.map((l, i) => <li key={i}>{inline(l, cites, `l${out.length}${i}`)}</li>)}</ul>); list = [] } }
  text.split('\n').forEach((line, i) => {
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (li) { list.push(li[1]); return }
    flush()
    if (!line.trim()) return
    if (line.startsWith('>')) out.push(<blockquote key={i}>{inline(line.replace(/^>\s?/, ''), cites, 'q' + i)}</blockquote>)
    else out.push(<p key={i}>{inline(line, cites, 'p' + i)}</p>)
  })
  flush()
  return <div className="prose-chat">{out}</div>
}

/** The graph "thinks": nodes fire in order of relevance while the answer streams. */
export function activate(r: { activations: Retrieval['activations']; edges: string[]; intent?: string; structured?: Retrieval['structured'] }) {
  const ids = r.activations.map((a) => a.node_id)
  const patch = useView.getState().patch
  patch({ activations: r.activations })
  if (!eng.current || !ids.length) return
  applyFocus('Answer', ids, r.edges, true)
  eng.current.ripple(r.activations.map((a) => ({ id: a.node_id, delay_ms: a.delay_ms + 350, hit: a.role === 'hit' })))
  if (r.intent === 'impact' && r.structured) patch({ impact: r.structured as never })
  if (r.intent === 'path' && r.structured) patch({ trace: r.structured as never })
}

export function ChatDock() {
  const threadId = useView((s) => s.threadId)
  const chatOpen = useView((s) => s.chatOpen)
  const railOpen = useView((s) => s.railOpen)
  const drawerOpen = useView((s) => s.drawerOpen)
  const draft = useView((s) => s.askDraft)
  const nodes = useView((s) => s.nodes)
  const kind = useView((s) => s.kind)
  const patch = useView.getState().patch
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const justCreated = useRef<string | null>(null) // a thread we created ourselves while sending: don't reload/abort for it

  useEffect(() => {
    if (threadId && justCreated.current === threadId) { justCreated.current = null; return }
    abort.current?.abort(); setBusy(false)
    if (!threadId) { setMsgs([]); return }
    let live = true
    setLoading(true)
    api.messages(eng.wsId, threadId).then((m) => live && setMsgs(m)).catch(() => live && setMsgs([])).finally(() => live && setLoading(false))
    return () => { live = false }
  }, [threadId])
  useEffect(() => { if (draft) { setText(draft); patch({ askDraft: '' }); area.current?.focus() } }, [draft, patch])
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }) }, [msgs])
  useEffect(() => () => abort.current?.abort(), [])

  const send = useCallback(async (raw?: string) => {
    const content = (raw ?? text).trim()
    if (!content || busy) return
    setText(''); setBusy(true); patch({ chatOpen: true })
    let tid = useView.getState().threadId
    try {
      if (!tid) {
        const t = await api.createThread(eng.wsId)
        tid = t.id
        justCreated.current = t.id
        patch({ threads: [t, ...useView.getState().threads], threadId: t.id })
      }
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Could not start a chat'); setBusy(false); return }
    const aid = 'a' + Date.now()
    setMsgs((m) => [...m, { id: 'u' + Date.now(), role: 'user', content }, { id: aid, role: 'assistant', content: '', streaming: true, meta: {} }])
    const upd = (fn: (m: ChatMessage) => ChatMessage) => setMsgs((all) => all.map((m) => (m.id === aid ? fn(m) : m)))
    abort.current = new AbortController()
    try {
      await streamChat(eng.wsId, tid!, content, {
        onRetrieval: (r) => { upd((m) => ({ ...m, meta: { ...m.meta, citations: r.citations, activations: r.activations, edges: r.edges, intent: r.intent, structured: r.structured } })); activate(r) },
        onToken: (t) => upd((m) => ({ ...m, content: m.content + t })),
        onError: (message) => toast.info(message),
        onDone: (d) => upd((m) => ({ ...m, content: d.answer || m.content, streaming: false, meta: { ...m.meta, citations: d.citations, followups: d.followups, provider: d.provider } })),
      }, abort.current.signal)
    } catch (e) {
      upd((m) => ({ ...m, streaming: false, content: m.content || 'The answer could not be completed.' }))
      toast.error(e instanceof ApiError ? e.message : 'Chat failed')
    } finally {
      upd((m) => ({ ...m, streaming: false }))
      setBusy(false)
      api.threads(eng.wsId).then((t) => patch({ threads: t })).catch(() => {})
    }
  }, [text, busy, patch])

  const isDocs = kind === 'docs'

  const top = [...nodes].filter((n) => n.type === 'Function' || n.type === 'Class' || n.type === 'File').sort((a, b) => b.score - a.score)[0]
  const starters = isDocs
    ? [
        'Summarize each document',
        'What are the key concepts across these files?',
        'Where do these documents disagree?',
      ]
    : [
        'What are the main parts of this project?',
        ...(top ? [`What would break if I change \`${top.label}\`?`] : []),
        'Summarize the key ideas in my documents',
      ]

  return (
    <div className="pointer-events-none absolute bottom-3 z-30 flex justify-center transition-[left,right] duration-300" style={{ left: railOpen ? 'max(0.75rem, min(20.75rem, 30vw))' : '0.75rem', right: drawerOpen ? 'max(0.75rem, min(26rem, 30vw))' : '0.75rem' }}>
      <section className="glass pointer-events-auto w-full max-w-[760px] rounded-2xl" aria-label="Chat with your graph">
        <AnimatePresence initial={false}>
          {chatOpen && (msgs.length > 0 || loading) && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div ref={scroller} className="max-h-[42vh] space-y-4 overflow-auto px-5 pb-2 pt-4" aria-live="polite">
                {msgs.map((m) => (
                  <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
                    {m.role === 'user' ? <div className="max-w-[85%] rounded-2xl rounded-br-md bg-plankton/14 px-3.5 py-2 text-[0.92rem]">{m.content}</div> : (
                      <div>
                        <div className="mb-1 flex items-center gap-2 text-[0.7rem] text-mist"><Sparkles size={12} className="text-plankton" /> NexMind {m.meta?.provider && m.meta.provider !== 'offline' ? `· ${m.meta.provider}` : m.streaming ? '' : '· offline answer'}
                          {m.meta?.activations && m.meta.activations.length > 0 && !m.streaming && <button className="chip ml-1 hover:text-ink" onClick={() => activate({ activations: m.meta!.activations!, edges: m.meta!.edges ?? [], intent: m.meta!.intent, structured: m.meta!.structured })}><Radio size={11} /> replay {m.meta.activations.length} nodes</button>}</div>
                        {m.content ? <div className={m.streaming ? 'caret' : ''}><Md text={m.content} cites={m.meta?.citations ?? []} /></div> : <div className="shimmer h-4 w-48 rounded" />}
                        {!m.streaming && m.meta?.followups && m.meta.followups.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{m.meta.followups.map((f) => <button key={f} className="chip !px-2.5 !py-1 text-[0.78rem] hover:!border-plankton/50 hover:text-ink" onClick={() => send(f)}>{f}</button>)}</div>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {msgs.length === 0 && !loading && chatOpen && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-3">{starters.map((s) => <button key={s} className="chip !px-2.5 !py-1 text-[0.78rem] hover:!border-plankton/50 hover:text-ink" onClick={() => send(s)}>{s}</button>)}</div>
        )}
        <form className="flex items-end gap-2 p-3" onSubmit={(e) => { e.preventDefault(); void send() }}>
          <button type="button" className="icon-btn shrink-0" aria-label={chatOpen ? 'Collapse chat' : 'Expand chat'} onClick={() => patch({ chatOpen: !chatOpen })}>{chatOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}</button>
          <textarea ref={area} rows={1} className="field !h-auto max-h-32 min-h-[2.6rem] resize-none py-2.5" placeholder={isDocs ? "Ask your documents anything — it will light up the answer" : "Ask your graph anything — it will light up the answer"} value={text}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} aria-label="Message" />
          {busy ? <button type="button" className="btn btn-ghost shrink-0 !px-3" aria-label="Stop" onClick={() => abort.current?.abort()}><Square size={15} /></button>
            : <button type="submit" className="btn btn-primary shrink-0 !px-3" disabled={!text.trim()} aria-label="Send"><SendHorizontal size={17} /></button>}
          {msgs.length > 0 && !busy && <button type="button" className="icon-btn shrink-0" aria-label="New chat" title="New chat" onClick={() => patch({ threadId: null })}><RotateCcw size={16} /></button>}
        </form>
      </section>
    </div>
  )
}
