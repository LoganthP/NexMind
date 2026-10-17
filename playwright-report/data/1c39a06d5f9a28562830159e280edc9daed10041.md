# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace.spec.ts >> E) Workspace page and interactive controls >> Left rail tabs: Sources, Chats, Insights, Flows, Filters
- Location: e2e\workspace.spec.ts:84:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('button:has-text("Sources")').first()
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('button:has-text("Sources")').first() with timeout 10000ms
  - waiting for locator('button:has-text("Sources")').first()

```

```yaml
- application "3D knowledge graph"
- banner:
  - link "Back to workspaces":
    - /url: /app
  - link:
    - /url: /
  - text: E2E Code Workspace
  - textbox "Search the graph":
    - /placeholder: Search symbols, files, ideas…
  - text: /
  - tablist "Mode":
    - tab "Explore" [selected]
    - tab "Impact"
    - tab "Trace"
    - tab "Flows"
  - button "Fit graph to screen (F)"
  - button "Auto-rotate (Space)" [pressed]
  - button "Export"
  - button "Display settings"
- complementary "Workspace panel":
  - button "Sources" [pressed]
  - button "Chats"
  - button "Insights"
  - button "Flows"
  - button "Filters"
  - button "Close side panel"
  - heading "Sources" [level=3]
  - button "Re-index all sources"
  - button "Add a source"
  - text: sample_code local · 0 files
  - button "Replace sample_code"
  - button "Remove sample_code"
  - button "client.js"
  - button "main.py"
  - button "service.py"
  - button "utils.py"
- region "Chat with your graph":
  - button "What are the main parts of this project?"
  - 'button "What would break if I change `run_app`?"'
  - button "Summarize the key ideas in my documents"
  - button "Collapse chat"
  - textbox "Message":
    - /placeholder: Ask your graph anything — it will light up the answer
  - button "Send" [disabled]
- text: 15 nodes · 26 links Function 6 File 4 Method 2 Class 1 Process 1 Source 1
- status
```

```
Error: E2E unexpected console.error(s):
Failed to load resource: the server responded with a status of 404 (Not Found)
```

# Test source

```ts
  1  | import { test as base, expect, type Page, type Response } from '@playwright/test'
  2  | 
  3  | export interface CustomFixtures {
  4  |   page: Page
  5  |   backendUrl: string
  6  |   allowFailedRequest: (filter: (url: string, status: number) => boolean) => void
  7  |   allowConsoleError: (filter: (text: string) => boolean) => void
  8  | }
  9  | 
  10 | export const test = base.extend<CustomFixtures>({
  11 |   backendUrl: async ({}, use) => {
  12 |     const port = process.env.NEXMIND_PORT || '8000'
  13 |     await use(`http://127.0.0.1:${port}`)
  14 |   },
  15 | 
  16 |   page: async ({ page, backendUrl }, use) => {
  17 |     const consoleErrors: string[] = []
  18 |     const pageErrors: Error[] = []
  19 |     const failedRequests: { url: string; status: number }[] = []
  20 | 
  21 |     const allowedRequestFilters: ((url: string, status: number) => boolean)[] = []
  22 |     const allowedConsoleFilters: ((text: string) => boolean)[] = []
  23 | 
  24 |     // Inject test API base before any scripts execute
  25 |     await page.addInitScript((base) => {
  26 |       try {
  27 |         window.localStorage.setItem('nexmind.api', base)
  28 |       } catch {}
  29 |     }, backendUrl)
  30 | 
  31 |     // Capture console.error
  32 |     page.on('console', (msg) => {
  33 |       if (msg.type() === 'error') {
  34 |         const text = msg.text()
  35 |         const isAllowed = allowedConsoleFilters.some((f) => f(text))
  36 |         if (!isAllowed) {
  37 |           consoleErrors.push(text)
  38 |         }
  39 |       }
  40 |     })
  41 | 
  42 |     // Capture uncaught exceptions / unhandled promise rejections
  43 |     page.on('pageerror', (err) => {
  44 |       pageErrors.push(err)
  45 |     })
  46 | 
  47 |     // Capture unexpected failed HTTP responses (4xx, 5xx)
  48 |     page.on('response', (res: Response) => {
  49 |       const status = res.status()
  50 |       const url = res.url()
  51 |       // Only track responses from our app / backend
  52 |       if (status >= 400 && (url.includes(':8000') || url.includes(':4173') || url.includes(backendUrl))) {
  53 |         const isAllowed = allowedRequestFilters.some((f) => f(url, status))
  54 |         if (!isAllowed) {
  55 |           failedRequests.push({ url, status })
  56 |         }
  57 |       }
  58 |     })
  59 | 
  60 |     // Attach custom helpers
  61 |     ;(page as any)._allowFailedRequest = (filter: (url: string, status: number) => boolean) => {
  62 |       allowedRequestFilters.push(filter)
  63 |     }
  64 |     ;(page as any)._allowConsoleError = (filter: (text: string) => boolean) => {
  65 |       allowedConsoleFilters.push(filter)
  66 |     }
  67 | 
  68 |     await use(page)
  69 | 
  70 |     // Assert zero errors occurred during test
  71 |     if (pageErrors.length > 0) {
  72 |       throw new Error(`E2E uncaught page error(s):\n${pageErrors.map((e) => e.stack || e.message).join('\n')}`)
  73 |     }
  74 |     if (consoleErrors.length > 0) {
> 75 |       throw new Error(`E2E unexpected console.error(s):\n${consoleErrors.join('\n')}`)
     |             ^ Error: E2E unexpected console.error(s):
  76 |     }
  77 |     if (failedRequests.length > 0) {
  78 |       throw new Error(`E2E unexpected failed request(s):\n${failedRequests.map((r) => `${r.status} ${r.url}`).join('\n')}`)
  79 |     }
  80 |   },
  81 | 
  82 |   allowFailedRequest: async ({ page }, use) => {
  83 |     await use((filter) => (page as any)._allowFailedRequest(filter))
  84 |   },
  85 | 
  86 |   allowConsoleError: async ({ page }, use) => {
  87 |     await use((filter) => (page as any)._allowConsoleError(filter))
  88 |   },
  89 | })
  90 | 
  91 | export { expect }
  92 | 
```