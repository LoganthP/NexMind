import type { GNode } from './types'

export function displayName(n: GNode): string {
  const lbl = (n.label || '').trim()
  if (!lbl || /^\(?(anonymous|untitled|unknown)\)?$/i.test(lbl)) {
    if (n.path) {
      const parts = n.path.split(/[/\\]/)
      let name = parts[parts.length - 1]
      const dot = name.lastIndexOf('.')
      if (dot > 0) name = name.substring(0, dot)
      if (name) return name
    }
    return 'Untitled ' + n.type
  }
  return lbl
}
