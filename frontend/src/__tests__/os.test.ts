import { describe, expect, it } from 'vitest'
import { COMMANDS, PIP_COMMAND, getUniversalConnectCommands, getBackendBase } from '@/lib/os'

describe('os command builders and rules', () => {
  it('commands never contain && on any operating system', () => {
    for (const [os, cmd] of Object.entries(COMMANDS)) {
      expect(cmd.run, `${os} run command must not contain &&`).not.toContain('&&')
      expect(cmd.first, `${os} first command must not contain &&`).not.toContain('&&')
    }
    expect(PIP_COMMAND, 'PIP_COMMAND must not contain &&').not.toContain('&&')
  })

  it('universal connect commands are correct for each OS and port without &&', () => {
    const script = 'connect' + '.py'
    const win = getUniversalConnectCommands('windows', 'http://127.0.0.1:8765')
    expect(win.primary).toMatch(new RegExp(`^irm "http://127\\.0\\.0\\.1:8765/${script}\\?k=[A-Za-z0-9_-]+" \\| python - \\.$`))
    expect(win.alt).toBe('& python -m nexmind connect .')
    expect(win.primary).not.toContain('&&')
    expect(win.alt).not.toContain('&&')

    const mac = getUniversalConnectCommands('mac', 'http://localhost:9000/')
    expect(mac.primary).toMatch(new RegExp(`^curl -fsSL "http://localhost:9000/${script}\\?k=[A-Za-z0-9_-]+" \\| python3 - \\.$`))
    expect(mac.alt).toBe('python3 -m nexmind connect .')
    expect(mac.primary).not.toContain('&&')
    expect(mac.alt).not.toContain('&&')

    const linux = getUniversalConnectCommands('linux', 'http://127.0.0.1:8000')
    expect(linux.primary).toMatch(new RegExp(`^curl -fsSL "http://127\\.0\\.0\\.1:8000/${script}\\?k=[A-Za-z0-9_-]+" \\| python3 - \\.$`))
    expect(linux.alt).toBe('python3 -m nexmind connect .')
  })

  it('getBackendBase returns fallback or env url without trailing slash', () => {
    const base = getBackendBase()
    expect(base).toMatch(/^http/)
    expect(base.endsWith('/')).toBe(false)
  })
})
