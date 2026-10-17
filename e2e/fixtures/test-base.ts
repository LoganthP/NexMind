import { test as base, expect, type Page, type Response } from '@playwright/test'

export interface CustomFixtures {
  page: Page
  backendUrl: string
  allowFailedRequest: (filter: (url: string, status: number) => boolean) => void
  allowConsoleError: (filter: (text: string) => boolean) => void
}

export const test = base.extend<CustomFixtures>({
  backendUrl: async ({}, use) => {
    const port = process.env.NEXMIND_PORT || '8000'
    await use(`http://127.0.0.1:${port}`)
  },

  page: async ({ page, backendUrl }, use) => {
    const consoleErrors: string[] = []
    const pageErrors: Error[] = []
    const failedRequests: { url: string; status: number }[] = []

    const allowedRequestFilters: ((url: string, status: number) => boolean)[] = []
    const allowedConsoleFilters: ((text: string) => boolean)[] = []

    // Inject test API base before any scripts execute
    await page.addInitScript((base) => {
      try {
        window.localStorage.setItem('nexmind.api', base)
      } catch {}
    }, backendUrl)

    // Capture console.error
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        const isAllowed = allowedConsoleFilters.some((f) => f(text))
        if (!isAllowed) {
          consoleErrors.push(text)
        }
      }
    })

    // Capture uncaught exceptions / unhandled promise rejections
    page.on('pageerror', (err) => {
      pageErrors.push(err)
    })

    // Capture unexpected failed HTTP responses (4xx, 5xx)
    page.on('response', (res: Response) => {
      const status = res.status()
      const url = res.url()
      // Only track responses from our app / backend
      if (status >= 400 && (url.includes(':8000') || url.includes(':4173') || url.includes(backendUrl))) {
        const isAllowed = allowedRequestFilters.some((f) => f(url, status))
        if (!isAllowed) {
          failedRequests.push({ url, status })
        }
      }
    })

    // Attach custom helpers
    ;(page as any)._allowFailedRequest = (filter: (url: string, status: number) => boolean) => {
      allowedRequestFilters.push(filter)
    }
    ;(page as any)._allowConsoleError = (filter: (text: string) => boolean) => {
      allowedConsoleFilters.push(filter)
    }

    await use(page)

    // Assert zero errors occurred during test
    if (pageErrors.length > 0) {
      throw new Error(`E2E uncaught page error(s):\n${pageErrors.map((e) => e.stack || e.message).join('\n')}`)
    }
    if (consoleErrors.length > 0) {
      throw new Error(`E2E unexpected console.error(s):\n${consoleErrors.join('\n')}`)
    }
    if (failedRequests.length > 0) {
      throw new Error(`E2E unexpected failed request(s):\n${failedRequests.map((r) => `${r.status} ${r.url}`).join('\n')}`)
    }
  },

  allowFailedRequest: async ({ page }, use) => {
    await use((filter) => (page as any)._allowFailedRequest(filter))
  },

  allowConsoleError: async ({ page }, use) => {
    await use((filter) => (page as any)._allowConsoleError(filter))
  },
})

export { expect }
