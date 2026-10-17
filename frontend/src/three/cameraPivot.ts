export interface Vec3 {
  x: number
  y: number
  z: number
}

/**
 * Computes camera position and lookAt target when flying to a node.
 * Keeps current view direction and never zooms out beyond current distance.
 */
export function flyTargetFor(
  nodePos: Vec3,
  camPos: Vec3,
  dist = 120,
  minDist = 15
): { pos: Vec3; target: Vec3 } {
  const dx = camPos.x - nodePos.x
  const dy = camPos.y - nodePos.y
  const dz = camPos.z - nodePos.z
  const currentDist = Math.sqrt(dx * dx + dy * dy + dz * dz)

  let dirX = 0
  let dirY = 0
  let dirZ = 1
  if (currentDist > 1e-6) {
    dirX = dx / currentDist
    dirY = dy / currentDist
    dirZ = dz / currentDist
  }

  // Never zoom out: if camera is already closer than dist, keep that closer distance (clamped to minDist)
  const targetDist = Math.max(minDist, Math.min(currentDist || dist, dist))

  return {
    pos: {
      x: nodePos.x + dirX * targetDist,
      y: nodePos.y + dirY * targetDist,
      z: nodePos.z + dirZ * targetDist,
    },
    target: {
      x: nodePos.x,
      y: nodePos.y,
      z: nodePos.z,
    },
  }
}

/**
 * Computes a new controls.target that is ON the camera's current view ray,
 * at the depth of the graph center:
 * t = clamp(dot(graphCenter - camPos, forward), minDist, maxDist)
 * target = camPos + forward * t
 *
 * This changes the orbit pivot without moving the camera or changing the picture on screen.
 */
export function releasePivot(
  camPos: Vec3,
  forward: Vec3,
  graphCenter: Vec3,
  minDist: number,
  maxDist: number
): Vec3 {
  const fLen = Math.sqrt(forward.x * forward.x + forward.y * forward.y + forward.z * forward.z)
  const fx = fLen > 1e-9 ? forward.x / fLen : 0
  const fy = fLen > 1e-9 ? forward.y / fLen : 0
  const fz = fLen > 1e-9 ? forward.z / fLen : -1

  const dx = graphCenter.x - camPos.x
  const dy = graphCenter.y - camPos.y
  const dz = graphCenter.z - camPos.z

  const dot = dx * fx + dy * fy + dz * fz
  const t = Math.min(maxDist, Math.max(minDist, dot))

  return {
    x: camPos.x + fx * t,
    y: camPos.y + fy * t,
    z: camPos.z + fz * t,
  }
}

/**
 * Keeps the pivot inside a sphere of radius 1.6 x graphRadius around the graph center
 * so panning can never lose the graph.
 */
export function clampTarget(
  target: Vec3,
  graphCenter: Vec3,
  radius: number
): Vec3 {
  const maxR = 1.6 * Math.max(radius, 10)
  const dx = target.x - graphCenter.x
  const dy = target.y - graphCenter.y
  const dz = target.z - graphCenter.z

  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (dist <= maxR || dist === 0) {
    return { x: target.x, y: target.y, z: target.z }
  }

  const factor = maxR / dist
  return {
    x: graphCenter.x + dx * factor,
    y: graphCenter.y + dy * factor,
    z: graphCenter.z + dz * factor,
  }
}

/**
 * Holds a numeric token and a lastUserInput timestamp.
 * begin() returns a new token for a programmatic move;
 * cancelAll() increments the token (invalidates every pending move);
 * isCurrent(token); markUserInput(); userActiveWithin(ms).
 */
export class CameraGuard {
  private token = 0
  private lastUserInput = 0

  begin(): number {
    this.token++
    return this.token
  }

  cancelAll(): void {
    this.token++
  }

  isCurrent(token: number): boolean {
    return token === this.token
  }

  markUserInput(): void {
    this.lastUserInput = Date.now()
  }

  userActiveWithin(ms: number): boolean {
    if (this.lastUserInput === 0) return false
    return Date.now() - this.lastUserInput < ms
  }

  getUserActiveMs(): number {
    if (this.lastUserInput === 0) return Infinity
    return Date.now() - this.lastUserInput
  }
}

/**
 * Pure moveCamera policy function extracted from the engine:
 * returns false for an automatic move within 1500 ms of user input,
 * true for forced moves, false for stale tokens.
 */
export function shouldRunMove(
  userActiveMs: number,
  force: boolean,
  tokenCurrent: boolean
): boolean {
  if (!tokenCurrent) return false
  if (force) return true
  if (userActiveMs < 1500) return false
  return true
}

/**
 * Pure policy: should the engine fly back to the saved view on deselect?
 *
 * Returns true when ALL of these hold:
 *   - a view was saved before the last flyTo   (hasMemory)
 *   - the user has NOT manually moved the camera (userMovedCamera = false)
 *   - the user has NOT been actively navigating in the last `thresholdMs` ms
 *
 * This is extracted from the engine so it can be unit-tested without Three.js.
 */
export function shouldRestore(
  hasMemory: boolean,
  userMovedCamera: boolean,
  userLastActiveMs: number,
  thresholdMs: number
): boolean {
  if (!hasMemory) return false
  if (userMovedCamera) return false
  if (userLastActiveMs < thresholdMs) return false
  return true
}
