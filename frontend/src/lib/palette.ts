import { useSettings } from './store'

/**
 * 3D Engine node colors.
 * These are the exact colors used by the 3D visualization engine.
 */
export const NODE_COLORS: Record<string, string> = {
  Source: '#f4f8ff',
  Folder: '#7f93ad',
  File: '#4cc9f0',
  Document: '#ffb35c',
  Section: '#ffd199',
  Class: '#a99bff',
  Function: '#5cf2d6',
  Method: '#8ff7e4',
  Module: '#ff7eb6',
  Concept: '#ffd666',
  Entity: '#ff8a8a',
  Process: '#38e8ff',
}

/**
 * High-contrast, WCAG-friendly equivalents for light backgrounds.
 */
export const LIGHT_NODE_COLORS: Record<string, string> = {
  Source: '#2d3748',
  Folder: '#4a5568',
  File: '#0284c7',
  Document: '#d97706',
  Section: '#b45309',
  Class: '#7c3aed',
  Function: '#0d9488',
  Method: '#0f766e',
  Module: '#db2777',
  Concept: '#ca8a04',
  Entity: '#dc2626',
  Process: '#0891b2',
}

/**
 * Helper to convert HSL to hex string.
 */
function hslToHex(h: number, s: number, l: number): string {
  l /= 100
  const a = (s * Math.min(l, 1 - l)) / 100
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0')
  }
  let hex = `#${f(0)}${f(8)}${f(4)}`.toLowerCase()
  // Ensure we never return the shared teal fallback
  if (hex === '#5cf2d6') {
    hex = '#e056fd'
  }
  return hex
}

/**
 * Deterministically hash an unknown node type into a stable color.
 * Never returns '#5cf2d6'.
 */
export function hashColor(type: string, theme: 'dark' | 'light'): string {
  let hash = 0
  for (let i = 0; i < type.length; i++) {
    hash = (hash << 5) - hash + type.charCodeAt(i)
    hash |= 0
  }
  const h = Math.abs(hash) % 360
  // Saturation and lightness tailored to theme
  const s = theme === 'light' ? 65 : 75
  const l = theme === 'light' ? 40 : 62
  const col = hslToHex(h, s, l)
  return col === '#5cf2d6' ? '#a855f7' : col
}

/**
 * Get current active theme ('dark' or 'light').
 */
export function currentTheme(): 'dark' | 'light' {
  if (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light') {
    return 'light'
  }
  try {
    return useSettings.getState().theme === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/**
 * Single source of truth for node type colors across the 3D engine,
 * the workspace legend, filters panel, and hover tooltip.
 */
export function typeColor(type: string, theme: 'dark' | 'light' = currentTheme()): string {
  if (theme === 'light') {
    return LIGHT_NODE_COLORS[type] ?? hashColor(type, 'light')
  }
  return NODE_COLORS[type] ?? hashColor(type, 'dark')
}
