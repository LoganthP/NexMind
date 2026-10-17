import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  releasePivot,
  clampTarget,
  CameraGuard,
  shouldRunMove,
  shouldRestore,
  flyTargetFor,
  type Vec3,
} from '@/three/cameraPivot'

describe('cameraPivot and CameraGuard', () => {
  describe('a) releasePivot keeps the screen image stable', () => {
    it('places new target on camPos + forward * t with normalised (target - camPos) equal to forward within 1e-6 and t clamped to [minDist, maxDist]', () => {
      const minDist = 15
      const maxDist = 2000

      // Test multiple random camera positions and forward vectors
      for (let i = 0; i < 20; i++) {
        const camPos: Vec3 = {
          x: (Math.random() - 0.5) * 1000,
          y: (Math.random() - 0.5) * 1000,
          z: (Math.random() - 0.5) * 1000,
        }

        // Random forward vector
        const rawFwd = {
          x: (Math.random() - 0.5) * 2,
          y: (Math.random() - 0.5) * 2,
          z: (Math.random() - 0.5) * 2,
        }
        const len = Math.sqrt(rawFwd.x ** 2 + rawFwd.y ** 2 + rawFwd.z ** 2) || 1
        const forward: Vec3 = {
          x: rawFwd.x / len,
          y: rawFwd.y / len,
          z: rawFwd.z / len,
        }

        const graphCenter: Vec3 = {
          x: (Math.random() - 0.5) * 400,
          y: (Math.random() - 0.5) * 400,
          z: (Math.random() - 0.5) * 400,
        }

        const target = releasePivot(camPos, forward, graphCenter, minDist, maxDist)

        // target - camPos
        const diff = {
          x: target.x - camPos.x,
          y: target.y - camPos.y,
          z: target.z - camPos.z,
        }
        const t = Math.sqrt(diff.x ** 2 + diff.y ** 2 + diff.z ** 2)

        // t is clamped to [minDist, maxDist]
        expect(t).toBeGreaterThanOrEqual(minDist - 1e-6)
        expect(t).toBeLessThanOrEqual(maxDist + 1e-6)

        // (target - camPos) normalized equals forward within 1e-6
        const normDiff = {
          x: diff.x / t,
          y: diff.y / t,
          z: diff.z / t,
        }
        expect(Math.abs(normDiff.x - forward.x)).toBeLessThan(1e-6)
        expect(Math.abs(normDiff.y - forward.y)).toBeLessThan(1e-6)
        expect(Math.abs(normDiff.z - forward.z)).toBeLessThan(1e-6)
      }
    })

    it('clamps t to minDist when graph center is behind the camera', () => {
      const camPos = { x: 0, y: 0, z: 100 }
      const forward = { x: 0, y: 0, z: -1 } // looking along -Z
      const graphCenter = { x: 0, y: 0, z: 200 } // behind camera at +Z
      const minDist = 20
      const maxDist = 1000

      const target = releasePivot(camPos, forward, graphCenter, minDist, maxDist)
      expect(target.x).toBeCloseTo(0, 5)
      expect(target.y).toBeCloseTo(0, 5)
      expect(target.z).toBeCloseTo(100 - 20, 5) // 80
    })

    it('clamps t to maxDist when graph center is extremely far ahead', () => {
      const camPos = { x: 0, y: 0, z: 0 }
      const forward = { x: 0, y: 0, z: -1 }
      const graphCenter = { x: 0, y: 0, z: -50000 }
      const minDist = 15
      const maxDist = 2000

      const target = releasePivot(camPos, forward, graphCenter, minDist, maxDist)
      expect(target.z).toBeCloseTo(-2000, 5)
    })
  })

  describe('b) clampTarget pulls far targets inside 1.6 x radius and leaves near targets untouched', () => {
    const center: Vec3 = { x: 10, y: 20, z: 30 }
    const radius = 100
    const maxAllowed = 1.6 * radius // 160

    it('leaves targets inside the 1.6 x radius sphere untouched', () => {
      const nearTarget: Vec3 = { x: 10 + 50, y: 20, z: 30 }
      const result = clampTarget(nearTarget, center, radius)
      expect(result.x).toBeCloseTo(nearTarget.x, 6)
      expect(result.y).toBeCloseTo(nearTarget.y, 6)
      expect(result.z).toBeCloseTo(nearTarget.z, 6)
    })

    it('pulls far target back onto the 1.6 x radius sphere boundary', () => {
      const farTarget: Vec3 = { x: 10 + 300, y: 20, z: 30 }
      const result = clampTarget(farTarget, center, radius)

      const dist = Math.sqrt(
        (result.x - center.x) ** 2 +
        (result.y - center.y) ** 2 +
        (result.z - center.z) ** 2
      )
      expect(dist).toBeCloseTo(maxAllowed, 5)
      expect(result.x).toBeCloseTo(10 + maxAllowed, 5)
      expect(result.y).toBeCloseTo(20, 5)
      expect(result.z).toBeCloseTo(30, 5)
    })

    it('clamps diagonal far targets correctly maintaining direction from center', () => {
      const farTarget: Vec3 = { x: 10 + 200, y: 20 + 200, z: 30 + 200 }
      const result = clampTarget(farTarget, center, radius)

      const dist = Math.sqrt(
        (result.x - center.x) ** 2 +
        (result.y - center.y) ** 2 +
        (result.z - center.z) ** 2
      )
      expect(dist).toBeCloseTo(maxAllowed, 5)

      // Direction should match original
      const origDir = 1 / Math.sqrt(3)
      const resDirX = (result.x - center.x) / dist
      const resDirY = (result.y - center.y) / dist
      const resDirZ = (result.z - center.z) / dist
      expect(resDirX).toBeCloseTo(origDir, 5)
      expect(resDirY).toBeCloseTo(origDir, 5)
      expect(resDirZ).toBeCloseTo(origDir, 5)
    })
  })

  describe('c) CameraGuard token cancellation and user activity tracking', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('after cancelAll(), a previously issued token is no longer current', () => {
      const guard = new CameraGuard()
      const t1 = guard.begin()
      expect(guard.isCurrent(t1)).toBe(true)

      guard.cancelAll()
      expect(guard.isCurrent(t1)).toBe(false)
    })

    it('subsequent begin() invalidates prior token', () => {
      const guard = new CameraGuard()
      const t1 = guard.begin()
      const t2 = guard.begin()
      expect(guard.isCurrent(t1)).toBe(false)
      expect(guard.isCurrent(t2)).toBe(true)
    })

    it('markUserInput() then userActiveWithin(1500) is true, and false after advancing fake timers by 2000 ms', () => {
      const guard = new CameraGuard()
      expect(guard.userActiveWithin(1500)).toBe(false)

      guard.markUserInput()
      expect(guard.userActiveWithin(1500)).toBe(true)

      vi.advanceTimersByTime(2000)
      expect(guard.userActiveWithin(1500)).toBe(false)
    })
  })

  describe('d) moveCamera policy (shouldRunMove)', () => {
    it('returns false for an automatic move within 1500 ms of user input', () => {
      expect(shouldRunMove(0, false, true)).toBe(false)
      expect(shouldRunMove(500, false, true)).toBe(false)
      expect(shouldRunMove(1499, false, true)).toBe(false)
    })

    it('returns true for an automatic move after 1500 ms of user input', () => {
      expect(shouldRunMove(1500, false, true)).toBe(true)
      expect(shouldRunMove(3000, false, true)).toBe(true)
      expect(shouldRunMove(Infinity, false, true)).toBe(true)
    })

    it('returns true for forced moves regardless of user activity', () => {
      expect(shouldRunMove(0, true, true)).toBe(true)
      expect(shouldRunMove(300, true, true)).toBe(true)
      expect(shouldRunMove(1400, true, true)).toBe(true)
      expect(shouldRunMove(5000, true, true)).toBe(true)
    })

    it('returns false for stale tokens even if forced or inactive', () => {
      expect(shouldRunMove(5000, false, false)).toBe(false)
      expect(shouldRunMove(5000, true, false)).toBe(false)
      expect(shouldRunMove(0, true, false)).toBe(false)
    })
  })

  describe('e) shouldRestore — view restore policy on deselect', () => {
    it('returns false when there is no saved view', () => {
      expect(shouldRestore(false, false, Infinity, 2000)).toBe(false)
    })

    it('returns false when the user manually moved the camera', () => {
      expect(shouldRestore(true, true, Infinity, 2000)).toBe(false)
    })

    it('returns false when the user was active within the threshold', () => {
      // userLastActiveMs=500, threshold=2000 → 500 < 2000 → false
      expect(shouldRestore(true, false, 500, 2000)).toBe(false)
    })

    it('returns false when user was active exactly at threshold boundary', () => {
      expect(shouldRestore(true, false, 1999, 2000)).toBe(false)
    })

    it('returns true when memory exists, camera not moved, user idle beyond threshold', () => {
      // userLastActiveMs=5000 > threshold=2000
      expect(shouldRestore(true, false, 5000, 2000)).toBe(true)
    })

    it('returns true when user has never been active (Infinity > threshold)', () => {
      expect(shouldRestore(true, false, Infinity, 2000)).toBe(true)
    })

    it('all three failing conditions together → false', () => {
      // no memory + user moved + active recently
      expect(shouldRestore(false, true, 100, 2000)).toBe(false)
    })
  })

  describe('f) flyTargetFor — keeps direction and never zooms out', () => {
    it('keeps direction and sets distance to defaultDist when camera is far', () => {
      const nodePos: Vec3 = { x: 10, y: 20, z: 30 }
      const camPos: Vec3 = { x: 10 + 300, y: 20, z: 30 }
      const res = flyTargetFor(nodePos, camPos, 120, 15)

      expect(res.target).toEqual(nodePos)
      expect(res.pos.x).toBeCloseTo(10 + 120, 5)
      expect(res.pos.y).toBeCloseTo(20, 5)
      expect(res.pos.z).toBeCloseTo(30, 5)
    })

    it('never zooms out when camera is already closer than defaultDist', () => {
      const nodePos: Vec3 = { x: 10, y: 20, z: 30 }
      const camPos: Vec3 = { x: 10 + 50, y: 20, z: 30 } // 50 < 120
      const res = flyTargetFor(nodePos, camPos, 120, 15)

      expect(res.target).toEqual(nodePos)
      expect(res.pos.x).toBeCloseTo(10 + 50, 5) // stays at 50, does NOT zoom out to 120
      expect(res.pos.y).toBeCloseTo(20, 5)
      expect(res.pos.z).toBeCloseTo(30, 5)
    })

    it('clamps to minDist when camera is extremely close', () => {
      const nodePos: Vec3 = { x: 0, y: 0, z: 0 }
      const camPos: Vec3 = { x: 0, y: 5, z: 0 } // 5 < 15
      const res = flyTargetFor(nodePos, camPos, 120, 15)

      expect(res.target).toEqual(nodePos)
      expect(res.pos.y).toBeCloseTo(15, 5)
    })
  })
})
