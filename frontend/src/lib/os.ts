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
