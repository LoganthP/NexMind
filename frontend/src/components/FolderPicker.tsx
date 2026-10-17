import { useEffect, useState } from 'react'
import { ChevronUp, Folder, HardDrive, Home, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import type { FsListing } from '@/lib/types'
import { Spinner } from './ui'

export function FolderPicker({ onPick, onClose }: { onPick: (path: string) => void; onClose: () => void }) {
  const [data, setData] = useState<FsListing | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const load = (p?: string) => {
    setLoading(true); setErr('')
    api.fsList(p).then(setData).catch((e) => setErr(e instanceof ApiError ? e.message : 'Cannot open folder')).finally(() => setLoading(false))
  }
  useEffect(() => load(), [])
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Choose a folder" onClick={onClose}>
      <div className="glass flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b hair px-4 py-3"><h3 className="font-semibold">Choose a project folder</h3><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <div className="flex flex-wrap gap-1.5 border-b hair px-4 py-2">
          {data?.roots.slice(0, 8).map((r) => (
            <button key={r.path} className="chip hover:text-ink" onClick={() => load(r.path)}>{r.name === 'Home' ? <Home size={12} /> : <HardDrive size={12} />}{r.name}</button>
          ))}
        </div>
        <div className="mono truncate border-b hair px-4 py-2 text-xs text-mist">{data?.path ?? '…'}</div>
        <div className="min-h-[200px] flex-1 overflow-auto p-2">
          {loading && <div className="grid h-40 place-items-center"><Spinner /></div>}
          {err && <p className="p-3 text-sm text-coral">{err}</p>}
          {!loading && data && (
            <ul>
              {data.parent && <li><button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-mist hover:bg-white/5" onClick={() => load(data.parent!)}><ChevronUp size={16} /> Up one level</button></li>}
              {data.entries.map((e) => (
                <li key={e.path}><button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/5" onClick={() => load(e.path)}><Folder size={16} className="text-plankton" /><span className="truncate">{e.name}</span></button></li>
              ))}
              {!data.entries.length && <li className="p-3 text-sm text-mist">No sub-folders here.</li>}
            </ul>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t hair px-4 py-3">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!data} onClick={() => data && onPick(data.path)}>Use this folder</button>
        </div>
      </div>
    </div>
  )
}
