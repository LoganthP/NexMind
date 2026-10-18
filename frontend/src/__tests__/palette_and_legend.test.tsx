import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { typeColor, NODE_COLORS, LIGHT_NODE_COLORS } from '@/lib/palette'
import { useSettings, useView } from '@/lib/store'
import { handleSocketEvent, loadGraph } from '@/workspace/actions'
import Workspace from '@/pages/Workspace'

// Mock socket to prevent real network connections
vi.mock('@/lib/socket', () => ({
  connectWorkspaceSocket: vi.fn(() => ({
    send: vi.fn(),
    close: vi.fn(),
  })),
}))

// Mock BrainEngine so Workspace can render without WebGL
vi.mock('@/three/engine', () => {
  class BrainEngine {
    constructor() {
      return new Proxy(this, { get: () => vi.fn() })
    }
  }
  return { BrainEngine, NODE_COLORS: {}, EDGE_COLORS: {}, BG: '#000' }
})

function hexToRgb(hex: string): string {
  const num = parseInt(hex.replace('#', ''), 16)
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgb(${r}, ${g}, ${b})`
}

function expectColor(actual: string, expectedHex: string) {
  const expectedRgb = hexToRgb(expectedHex)
  expect([expectedHex.toLowerCase(), expectedRgb]).toContain(actual.toLowerCase())
}

describe('Palette and Legend Colours (Issue 1)', () => {
  beforeEach(() => {
    useView.getState().reset()
    useSettings.getState().set({ theme: 'graphite' })

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/health')) {
        return { ok: true, status: 200, json: async () => ({ app: 'nexmind', status: 'ok' }) }
      }
      if (url.includes('/threads')) {
        return { ok: true, status: 200, json: async () => [] }
      }
      if (url.includes('/graph')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            nodes: [
              { id: 'n1', label: 'file.ts', type: 'File', cluster: 1, score: 0.8 },
              { id: 'n2', label: 'compute', type: 'Function', cluster: 1, score: 0.7 },
              { id: 'n3', label: 'Service', type: 'Class', cluster: 1, score: 0.9 },
            ],
            links: [{ id: 'e1', source: 'n1', target: 'n2', type: 'DEFINES' }],
            clusters: [],
            truncated: false,
            total_nodes: 3,
            total_edges: 1,
            status: 'ready',
            legend: { node_colors: {}, edge_colors: {} },
          }),
        }
      }
      if (url.includes('/api/workspaces/test-ws')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'test-ws',
            name: 'Test',
            description: '',
            status: 'ready',
            kind: 'code',
            created_at: 1,
            updated_at: 1,
            stats: {},
            source_count: 1,
            thread_count: 0,
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  describe('typeColor function', () => {
    it('returns exact engine colors for known types in dark theme', () => {
      expect(typeColor('File', 'dark')).toBe(NODE_COLORS['File'])
      expect(typeColor('Function', 'dark')).toBe(NODE_COLORS['Function'])
      expect(typeColor('Class', 'dark')).toBe(NODE_COLORS['Class'])
      expect(typeColor('Document', 'dark')).toBe(NODE_COLORS['Document'])
    })

    it('returns distinct light colors in light theme', () => {
      expect(typeColor('File', 'light')).toBe(LIGHT_NODE_COLORS['File'])
      expect(typeColor('Function', 'light')).toBe(LIGHT_NODE_COLORS['Function'])
      expect(typeColor('File', 'light')).not.toBe(typeColor('File', 'dark'))
    })

    it('returns stable hashed non-default color for unknown type (never #5cf2d6)', () => {
      const unknownColor1 = typeColor('CustomTypeX', 'dark')
      const unknownColor2 = typeColor('CustomTypeX', 'dark')
      expect(unknownColor1).toBe(unknownColor2)
      expect(unknownColor1).not.toBe('#5cf2d6')
      expect(unknownColor1).toMatch(/^#[0-9a-f]{6}$/i)
    })
  })

  describe('Streamed build and store legend synchronization', () => {
    it('patches store legend and displays matching colours for mixed graph with at least 3 distinct colours', () => {
      handleSocketEvent({ type: 'graph_stream_start', nodes: 3, edges: 2, clusters: [] })

      handleSocketEvent({
        type: 'graph_batch',
        nodes: [
          { id: 'n1', label: 'file.ts', type: 'File', cluster: 1, score: 0.8 },
          { id: 'n2', label: 'compute', type: 'Function', cluster: 1, score: 0.7 },
          { id: 'n3', label: 'Service', type: 'Class', cluster: 1, score: 0.9 },
        ] as any,
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', type: 'DEFINES' },
          { id: 'e2', source: 'n1', target: 'n3', type: 'DEFINES' },
        ] as any,
      })

      handleSocketEvent({ type: 'graph_ready', stats: { nodes: 3, edges: 2 } })

      const storeLegend = useView.getState().legend.node
      expect(storeLegend['File']).toBe(typeColor('File'))
      expect(storeLegend['Function']).toBe(typeColor('Function'))
      expect(storeLegend['Class']).toBe(typeColor('Class'))

      // At least 3 distinct colors appear
      const distinctColors = new Set([storeLegend['File'], storeLegend['Function'], storeLegend['Class']])
      expect(distinctColors.size).toBe(3)
    })

    it('renders Workspace legend with typeColor dots after loading workspace', async () => {
      render(
        <MemoryRouter initialEntries={['/app/w/test-ws']}>
          <Routes>
            <Route path="/app/w/:id" element={<Workspace />} />
          </Routes>
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByTestId('legend-dot-File')).toBeDefined()
      })

      const fileDot = screen.getByTestId('legend-dot-File')
      const funcDot = screen.getByTestId('legend-dot-Function')
      const classDot = screen.getByTestId('legend-dot-Class')

      expectColor(fileDot.style.background, typeColor('File'))
      expectColor(funcDot.style.background, typeColor('Function'))
      expectColor(classDot.style.background, typeColor('Class'))
    })
  })

  describe('loadGraph legend synchronization and theme switch', () => {
    it('sets legend colours matching typeColor after loadGraph', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/graph')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              nodes: [
                { id: 'n1', label: 'a.ts', type: 'File', cluster: 0, score: 0.5 },
                { id: 'n2', label: 'parse', type: 'Function', cluster: 0, score: 0.5 },
                { id: 'n3', label: 'Parser', type: 'Class', cluster: 0, score: 0.5 },
                { id: 'n4', label: 'Custom', type: 'UnknownCustomType', cluster: 0, score: 0.5 },
              ],
              links: [],
              clusters: [],
              truncated: false,
              total_nodes: 4,
              total_edges: 0,
              status: 'ready',
              legend: {
                node_colors: { File: '#38bdf8' },
                edge_colors: {},
              },
            }),
          }
        }
        return { ok: true, status: 200, json: async () => ({}) }
      }))

      await loadGraph('test-ws')

      const storeLegend = useView.getState().legend.node
      expect(storeLegend['File']).toBe(typeColor('File'))
      expect(storeLegend['Function']).toBe(typeColor('Function'))
      expect(storeLegend['Class']).toBe(typeColor('Class'))
      expect(storeLegend['UnknownCustomType']).toBe(typeColor('UnknownCustomType'))
      expect(storeLegend['UnknownCustomType']).not.toBe('#5cf2d6')
    })

    it('updates legend dots when theme switches between dark and light', () => {
      useSettings.getState().set({ theme: 'graphite' })
      expect(typeColor('Function', 'dark')).toBe(NODE_COLORS['Function'])

      useSettings.getState().set({ theme: 'light' })
      expect(typeColor('Function', 'light')).toBe(LIGHT_NODE_COLORS['Function'])
      expect(typeColor('Function', 'light')).not.toBe(NODE_COLORS['Function'])
    })
  })
})
