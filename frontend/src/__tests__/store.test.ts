import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useSettings, useToasts, toast, useView } from '@/lib/store'

describe('Zustand stores and toasts', () => {
  beforeEach(() => {
    localStorage.clear()
    useToasts.setState({ items: [] })
    useView.getState().reset()
  })

  describe('useSettings', () => {
    it('persists settings to localStorage and updates document dataset', () => {
      useSettings.getState().set({ solid: true, theme: 'graphite' })
      expect(document.documentElement.dataset.solid).toBe('true')

      const saved = JSON.parse(localStorage.getItem('nexmind.settings') || '{}')
      expect(saved.solid).toBe(true)
      expect(saved.theme).toBe('graphite')
    })
  })

  describe('useToasts', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('caps active toasts at 2 items', () => {
      toast.info('Message 1')
      toast.info('Message 2')
      toast.info('Message 3')

      const items = useToasts.getState().items
      expect(items.length).toBeLessThanOrEqual(2)
      expect(items.map((i) => i.baseText)).toEqual(['Message 2', 'Message 3'])
    })

    it('de-duplicates identical toasts within 5 seconds and updates count x2, x3', () => {
      toast.error('Network failure')
      expect(useToasts.getState().items.length).toBe(1)
      expect(useToasts.getState().items[0].count).toBe(1)

      // Same error again
      toast.error('Network failure')
      expect(useToasts.getState().items.length).toBe(1)
      expect(useToasts.getState().items[0].count).toBe(2)
      expect(useToasts.getState().items[0].text).toContain('x2')

      // Third time
      toast.error('Network failure')
      expect(useToasts.getState().items.length).toBe(1)
      expect(useToasts.getState().items[0].count).toBe(3)
      expect(useToasts.getState().items[0].text).toContain('x3')
    })

    it('auto-dismisses toasts after timer expires', () => {
      toast.info('Temporary message')
      expect(useToasts.getState().items.length).toBe(1)

      // info auto-dismisses after 3800 ms
      vi.advanceTimersByTime(4000)
      expect(useToasts.getState().items.length).toBe(0)
    })

    it('dismisses toast explicitly by id', () => {
      toast.success('Done')
      const item = useToasts.getState().items[0]
      expect(item).toBeTruthy()

      useToasts.getState().dismiss(item.id)
      expect(useToasts.getState().items.length).toBe(0)
    })
  })

  describe('useView', () => {
    it('patches view state and resets cleanly to pristine state', () => {
      useView.getState().patch({
        mode: 'impact',
        selectedId: 'node-123',
        totalNodes: 50,
      })

      expect(useView.getState().mode).toBe('impact')
      expect(useView.getState().selectedId).toBe('node-123')
      expect(useView.getState().totalNodes).toBe(50)

      useView.getState().reset()

      expect(useView.getState().mode).toBe('explore')
      expect(useView.getState().selectedId).toBeNull()
      expect(useView.getState().totalNodes).toBe(0)
      expect(useView.getState().nodes).toEqual([])
    })
  })
})
