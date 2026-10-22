let activeOperations = 0

export function beginActivity(): () => void {
  activeOperations++
  return () => {
    endActivity()
  }
}

export function endActivity(): void {
  activeOperations = Math.max(0, activeOperations - 1)
}

export function isActivityInProgress(): boolean {
  return activeOperations > 0
}
