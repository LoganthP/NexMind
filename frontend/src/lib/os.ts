export type OS = 'windows' | 'mac' | 'linux'
export function detectOS(): OS {
  const ua = (navigator.userAgent || '').toLowerCase()
  if (ua.includes('win')) return 'windows'
  if (ua.includes('mac')) return 'mac'
  return 'linux'
}
export const COMMANDS: Record<OS, { label: string; shell: string; run: string; first: string }> = {
  windows: {
    label: 'Windows', shell: 'PowerShell',
    first: 'cd nexmind\\backend',
    run: 'powershell -ExecutionPolicy Bypass -File .\\start.ps1',
  },
  mac: { label: 'macOS', shell: 'Terminal', first: 'cd nexmind/backend', run: './start.sh' },
  linux: { label: 'Linux', shell: 'Terminal', first: 'cd nexmind/backend', run: './start.sh' },
}
export const PIP_COMMAND = 'pip install -e . ; nexmind serve'

/**
 * Returns the backend base URL:
 *   1. VITE_API_URL env variable (set at build time for a hosted Vercel deployment)
 *   2. Fallback to http://127.0.0.1:8000
 */
export function getBackendBase(): string {
  // import.meta.env is replaced at build time by Vite
  const envUrl = typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_API_URL : undefined
  return (envUrl || 'http://127.0.0.1:8000').replace(/\/$/, '')
}

/**
 * Returns the one-liner shell commands a remote user needs to run
 * to connect their project folder without installing anything.
 *
 *   Windows PowerShell:
 *     irm <base>/connect.py | python - .
 *   macOS / Linux:
 *     curl -fsSL <base>/connect.py | python3 - .
 */
export function getUniversalConnectCommands(os: OS, base?: string): { primary: string; alt: string } {
  const backendBase = (base || getBackendBase()).replace(/\/$/, '')
  const scriptUrl = `${backendBase}/connect.py`

  if (os === 'windows') {
    return {
      primary: `irm ${scriptUrl} | python - .`,
      alt: `& python -m nexmind connect .`,
    }
  }
  return {
    primary: `curl -fsSL ${scriptUrl} | python3 - .`,
    alt: `python3 -m nexmind connect .`,
  }
}
