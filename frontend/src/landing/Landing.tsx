import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { ArrowRight, Eye, GitBranch, Lock, MessageSquareText, Network, Waypoints, Zap } from 'lucide-react'
import { Aurora, CopyBlock, Logo, Spot } from '@/components/ui'
import { COMMANDS, detectOS, type OS } from '@/lib/os'
import { LandingEngine as BrainEngine } from './LandingEngine'
import { makeDemoGraph } from './demo'

gsap.registerPlugin(ScrollTrigger)

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

export default function Landing() {
  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [webgl, setWebgl] = useState(true)
  const [os, setOs] = useState<OS>('windows')
  useEffect(() => setOs(detectOS()), [])

  // ---- the hero brain: a real engine instance fed with a generated graph, camera driven by scroll
  useEffect(() => {
    const el = stage.current
    if (!el) return
    let engine: BrainEngine | null = null
    try {
      engine = new BrainEngine(el, { interactive: false, quality: matchMedia('(max-width: 700px)').matches ? 'low' : 'high', autoRotate: false, labels: false })
    } catch { setWebgl(false); return }
    const g = makeDemoGraph(520, 7)
    // stream it in so the first thing a visitor sees is the graph growing
    engine.setClusters(g.clusters)
    let i = 0
    const nodes = g.nodes
    const batch = 40
    const sent = new Set<string>()
    let pending = [...g.links]
    const feed = window.setInterval(() => {
      if (!engine) return
      const slice = nodes.slice(i, i + batch)
      slice.forEach((n) => sent.add(n.id))
      const ready = pending.filter((l) => sent.has(l.source as string) && sent.has(l.target as string))
      pending = pending.filter((l) => !(sent.has(l.source as string) && sent.has(l.target as string)))
      engine.addBatch(slice.map((n) => ({ ...n })), ready.map((l) => ({ ...l })))
      i += batch
      if (i >= nodes.length) { window.clearInterval(feed); engine.setClusters(g.clusters) }
    }, 90)

    const state = { p: 0 }
    let raf = 0
    const t0 = performance.now()
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const t = (performance.now() - t0) / 1000
      const calm = reduced()
      const angle = (calm ? 0.6 : t * 0.07) + state.p * Math.PI * 1.15
      const elev = 0.22 + state.p * 0.55
      const dist = 430 - state.p * 150
      engine?.orbit(angle, elev, dist)
    }
    raf = requestAnimationFrame(loop)

    const ctx = gsap.context(() => {
      if (!reduced()) {
        gsap.to(state, { p: 1, ease: 'none', scrollTrigger: { trigger: root.current, start: 'top top', end: 'bottom bottom', scrub: 0.8 } })
        gsap.to(el, { opacity: 0.32, ease: 'none', scrollTrigger: { trigger: '#features', start: 'top 85%', end: 'top 25%', scrub: true } })
        gsap.utils.toArray<HTMLElement>('[data-speed]').forEach((n) => {
          gsap.to(n, { yPercent: -Number(n.dataset.speed) * 30, ease: 'none', scrollTrigger: { trigger: root.current, start: 'top top', end: 'bottom bottom', scrub: true } })
        })
        gsap.utils.toArray<HTMLElement>('[data-reveal]').forEach((n) => {
          gsap.from(n, { opacity: 0, y: 36, duration: 0.9, ease: 'power3.out', scrollTrigger: { trigger: n, start: 'top 88%', once: true } })
        })
      }
      ScrollTrigger.create({ trigger: '#run', start: 'top 70%', end: 'bottom top', onEnter: () => engine?.pause(), onLeaveBack: () => engine?.resume() })
    }, root)

    return () => { window.clearInterval(feed); cancelAnimationFrame(raf); ctx.revert(); ScrollTrigger.getAll().forEach((s) => s.kill()); engine?.dispose(); engine = null }
  }, [])

  const cmd = COMMANDS[os]
  return (
    <div ref={root} className="relative bg-abyss text-ink">
      <Aurora />
      <div ref={stage} className="fixed inset-0 z-0" aria-hidden />
      {!webgl && <div className="fixed inset-0 z-0 bg-[radial-gradient(circle_at_70%_40%,#12405a,transparent_60%)]" />}
      <div className="pointer-events-none fixed inset-0 z-[1] bg-[radial-gradient(ellipse_at_20%_50%,rgba(4,10,18,0.88),transparent_62%)]" />

      <nav className="fixed inset-x-0 top-0 z-50 mx-auto flex max-w-7xl items-center justify-between px-5 py-4" aria-label="Main">
        <Link to="/" aria-label="NexMind home"><Logo size={30} /></Link>
        <div className="hidden items-center gap-7 text-sm text-mist md:flex">
          <a className="hover:text-ink" href="#features">What it does</a>
          <a className="hover:text-ink" href="#run">How it runs</a>
        </div>
        <Link to="/app" className="btn btn-primary !h-10">Open the app <ArrowRight size={16} /></Link>
      </nav>

      {/* ------------------------------------------------------------- hero */}
      <header className="relative z-10 mx-auto flex min-h-screen max-w-7xl items-center px-5">
        <div className="max-w-[40rem] pt-16" data-speed="0.6">
          <h1 className="text-[clamp(2.7rem,7.2vw,5.7rem)] font-extrabold leading-[0.98] tracking-[-0.035em]">See your code and documents think.</h1>
          <p className="mt-6 max-w-[34rem] text-[clamp(1.02rem,1.5vw,1.2rem)] leading-relaxed text-[#b4c9de]">
            Drop in a repository or a stack of PDFs. NexMind grows a living 3D map of how everything connects, then answers your questions by lighting up the exact path it followed.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link to="/app" className="btn btn-primary !h-12 !px-6 !text-base">Open NexMind <ArrowRight size={18} /></Link>
            <a href="#run" className="btn btn-ghost !h-12 !px-6 !text-base">See how it starts</a>
          </div>
          <p className="mt-8 text-sm text-mist">The brain behind this text is generated live in your browser: 520 nodes, 7 clusters, no server involved.</p>
        </div>
      </header>

      {/* ------------------------------------------------------------- features */}
      <section id="features" className="relative z-10 mx-auto max-w-7xl px-5 pb-28 pt-24">
        <div data-reveal className="max-w-2xl">
          <h2 className="text-[clamp(1.9rem,4vw,3.1rem)] font-bold leading-tight tracking-tight">One graph for the code you wrote and the documents that explain it.</h2>
          <p className="mt-4 text-lg text-[#9fb6cd]">Functions link to the README sections that mention them. Concepts link across PDFs. Every link comes with the evidence behind it.</p>
        </div>

        <div className="mt-12 grid auto-rows-[minmax(11rem,auto)] gap-4 md:grid-cols-6">
          <Spot className="md:col-span-4 md:row-span-2"><div data-reveal className="relative z-10 flex h-full flex-col justify-between p-7">
            <div><Network className="text-plankton" /><h3 className="mt-4 text-2xl font-bold">Watch the graph grow while it builds</h3>
              <p className="mt-2 max-w-md text-[#9fb6cd]">The server streams nodes as they are placed, heaviest first. You see structure appear in seconds instead of staring at a progress bar.</p></div>
            <GrowthStrip />
          </div></Spot>
          <Spot className="md:col-span-2"><div data-reveal className="relative z-10 p-6"><Eye className="text-jelly" /><h3 className="mt-3 text-lg font-semibold">Hover for the why</h3><p className="mt-1.5 text-sm text-[#9fb6cd]">Hover any link and read, in plain words, why two things are connected, with the line of code or text that proves it.</p></div></Spot>
          <Spot className="md:col-span-2"><div data-reveal className="relative z-10 p-6"><Zap className="text-coral" /><h3 className="mt-3 text-lg font-semibold">What breaks if I change this?</h3><p className="mt-1.5 text-sm text-[#9fb6cd]">Pick a function and watch a shock wave travel through everything that depends on it, with a risk rating.</p></div></Spot>
          <Spot className="md:col-span-3"><div data-reveal className="relative z-10 p-6"><Waypoints className="text-amber" /><h3 className="mt-3 text-lg font-semibold">Follow a call through your code</h3><p className="mt-1.5 text-sm text-[#9fb6cd]">Play an execution flow step by step: a pulse walks from the entry point through every function it reaches.</p></div></Spot>
          <Spot className="md:col-span-3"><div data-reveal className="relative z-10 p-6"><MessageSquareText className="text-plankton" /><h3 className="mt-3 text-lg font-semibold">Answers that light up</h3><p className="mt-1.5 text-sm text-[#9fb6cd]">Ask a question and the nodes behind the answer fire in order, with numbered citations you can click.</p></div></Spot>
          <Spot className="md:col-span-3"><div data-reveal className="relative z-10 p-6"><GitBranch className="text-[#4cc9f0]" /><h3 className="mt-3 text-lg font-semibold">GitHub, GitLab, a folder, or a PDF</h3><p className="mt-1.5 text-sm text-[#9fb6cd]">Paste a repo link (private repos with a token), point at a folder on your machine, or drop in documents.</p></div></Spot>
          <Spot className="md:col-span-3"><div data-reveal className="relative z-10 p-6"><Lock className="text-[#8ff7a8]" /><h3 className="mt-3 text-lg font-semibold">Your code stays on your computer</h3><p className="mt-1.5 text-sm text-[#9fb6cd]">The server runs locally. This website is only the window; nothing you analyze is uploaded to it.</p></div></Spot>
        </div>
      </section>

      {/* ------------------------------------------------------------- how it runs */}
      <section id="run" className="relative z-10 border-t hair bg-abyss/85 py-28">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 lg:grid-cols-2">
          <div data-reveal>
            <h2 className="text-[clamp(1.9rem,4vw,3rem)] font-bold leading-tight tracking-tight">One command, and the page finds your server.</h2>
            <p className="mt-4 max-w-lg text-lg text-[#9fb6cd]">NexMind has two parts: this website and a small server on your computer. Start the server once; the website detects it and connects on its own.</p>
            <ol className="mt-8 space-y-5">
              {[['Start the server', 'Run the command in the backend folder. The first run installs what it needs.'], ['The page connects by itself', 'It listens on 127.0.0.1:8000 and turns green the moment the server answers.'], ['Pick a repo or documents', 'Paste a link, choose a folder or drop files, then watch the graph build.']].map(([t, d], i) => (
                <li key={t} className="flex gap-4"><span className="mono mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-plankton/40 text-sm text-plankton">{i + 1}</span><div><h3 className="font-semibold">{t}</h3><p className="text-sm text-[#9fb6cd]">{d}</p></div></li>
              ))}
            </ol>
            <div className="mt-8 max-w-lg space-y-3">
              <div className="flex gap-1" role="tablist" aria-label="Operating system">{(Object.keys(COMMANDS) as OS[]).map((k) => <button key={k} role="tab" aria-selected={os === k} className="tab !text-xs" onClick={() => setOs(k)}>{COMMANDS[k].label}</button>)}</div>
              <CopyBlock label={cmd.shell} command={cmd.run} />
            </div>
          </div>
          <div data-reveal><ConnectDemo cmd={cmd.run} /></div>
        </div>
      </section>

      <section className="relative z-10 border-t hair bg-abyss/95 py-24 text-center">
        <div className="mx-auto max-w-2xl px-5" data-reveal>
          <h2 className="text-[clamp(1.9rem,4vw,3rem)] font-bold tracking-tight">Give your project a brain you can walk through.</h2>
          <Link to="/app" className="btn btn-primary mt-8 !h-12 !px-7 !text-base">Open NexMind <ArrowRight size={18} /></Link>
        </div>
      </section>
      <footer className="relative z-10 border-t hair bg-abyss py-8 text-center text-sm text-mist">NexMind · repository and document intelligence</footer>
    </div>
  )
}

/** A tiny looping strip that shows nodes appearing, purely decorative. */
function GrowthStrip() {
  const dots = Array.from({ length: 34 }, (_, i) => i)
  return (
    <div className="mt-8 flex h-16 items-end gap-1.5" aria-hidden>
      {dots.map((i) => (<i key={i} className="block flex-1 rounded-full bg-gradient-to-t from-plankton/10 to-plankton" style={{ height: `${18 + ((i * 37) % 80)}%`, animation: `rise 3.2s ${(i % 12) * 0.12}s ease-in-out infinite alternate`, boxShadow: '0 0 14px rgba(92,242,214,.35)' }} />))}
      <style>{`@keyframes rise{from{transform:scaleY(.25);opacity:.4}to{transform:scaleY(1);opacity:1}}`}</style>
    </div>
  )
}

/** A looping mock of the connect flow so visitors see what will happen. */
function ConnectDemo({ cmd }: { cmd: string }) {
  const [step, setStep] = useState(0)
  useEffect(() => { const t = setInterval(() => setStep((s) => (s + 1) % 5), 2300); return () => clearInterval(t) }, [])
  const typed = step === 0 ? cmd.slice(0, 14) : cmd
  return (
    <div className="glass overflow-hidden rounded-2xl" aria-label="Animated preview of connecting to the local server">
      <div className="flex items-center gap-1.5 border-b hair px-4 py-2.5"><i className="h-2.5 w-2.5 rounded-full bg-coral/80" /><i className="h-2.5 w-2.5 rounded-full bg-amber/80" /><i className="h-2.5 w-2.5 rounded-full bg-plankton/80" /><span className="ml-2 text-xs text-mist">terminal</span></div>
      <pre className="mono min-h-[7.5rem] overflow-hidden whitespace-pre-wrap px-4 py-4 text-[0.8rem] leading-relaxed"><span className="text-plankton">$ </span>{typed}{step === 0 && <span className="caret" />}
        {step >= 1 && <><br /><span className="text-mist">NexMind 1.1.0 → http://127.0.0.1:8000</span></>}
        {step >= 2 && <><br /><span className="text-mist">Web app detected this server</span></>}</pre>
      <div className="border-t hair px-4 py-4">
        <div className="flex items-center gap-3 rounded-xl bg-black/35 px-4 py-3">
          <span className={`pulse-dot ${step < 2 ? 'off' : ''}`} />
          <div className="text-sm"><div className={`font-medium ${step >= 2 ? 'text-plankton' : ''}`}>{step < 2 ? 'Waiting for local server…' : 'Connected to NexMind 1.1.0'}</div><div className="text-xs text-mist">{step < 2 ? 'Checking 127.0.0.1:8000' : step >= 4 ? 'Graph growing: 412 / 640 nodes' : 'Choose what to analyze'}</div></div>
        </div>
        {step >= 3 && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-plankton to-jelly transition-all duration-[2200ms]" style={{ width: step >= 4 ? '64%' : '8%' }} /></div>}
      </div>
    </div>
  )
}
