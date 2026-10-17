import { describe, expect, it } from 'vitest'
import { displayName } from '@/lib/names'
import type { GNode } from '@/lib/types'

describe('names.displayName sanitization', () => {
  it('returns valid label as is', () => {
    const node: GNode = {
      id: '1',
      type: 'Function',
      label: 'process_data',
      score: 0.5,
      degree: 2,
      in_degree: 1,
      out_degree: 1,
      betweenness: 0.1,
      cluster: 1,
      x: 0,
      y: 0,
      z: 0,
    }
    expect(displayName(node)).toBe('process_data')
  })

  it('sanitizes (anonymous), untitled, unknown by falling back to file basename without extension', () => {
    const node: GNode = {
      id: '2',
      type: 'Module',
      label: 'untitled',
      path: '/src/services/auth_handler.py',
      score: 0.5,
      degree: 2,
      in_degree: 1,
      out_degree: 1,
      betweenness: 0.1,
      cluster: 1,
      x: 0,
      y: 0,
      z: 0,
    }
    expect(displayName(node)).toBe('auth_handler')

    const anonNode: GNode = {
      ...node,
      label: '(anonymous)',
      path: 'C:\\Users\\admin\\project\\utils.ts',
    }
    expect(displayName(anonNode)).toBe('utils')
  })

  it('falls back to "Untitled <Type>" when no path exists', () => {
    const node: GNode = {
      id: '3',
      type: 'Document',
      label: 'unknown',
      score: 0.5,
      degree: 0,
      in_degree: 0,
      out_degree: 0,
      betweenness: 0,
      cluster: 0,
      x: 0,
      y: 0,
      z: 0,
    }
    expect(displayName(node)).toBe('Untitled Document')
  })

  it('handles empty or whitespace-only label', () => {
    const node: GNode = {
      id: '4',
      type: 'Class',
      label: '   ',
      score: 0.5,
      degree: 0,
      in_degree: 0,
      out_degree: 0,
      betweenness: 0,
      cluster: 0,
      x: 0,
      y: 0,
      z: 0,
    }
    expect(displayName(node)).toBe('Untitled Class')
  })
})
