# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: startup.spec.ts >> A) Startup and connection >> browser back and forward navigation works smoothly between landing and hub
- Location: e2e\startup.spec.ts:23:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('text=/Explore codebases/i, text=/NexMind/i').first()
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('text=/Explore codebases/i, text=/NexMind/i').first() with timeout 10000ms
  - waiting for locator('text=/Explore codebases/i, text=/NexMind/i').first()

```

```yaml
- navigation "Main":
  - link "NexMind home":
    - /url: /
    - text: NexMind
  - link "What it does":
    - /url: "#features"
  - link "How it runs":
    - /url: "#run"
  - link "Open the app":
    - /url: /app
- banner:
  - heading "See your code and documents think." [level=1]
  - paragraph: Drop in a repository or a stack of PDFs. NexMind grows a living 3D map of how everything connects, then answers your questions by lighting up the exact path it followed.
  - link "Open NexMind":
    - /url: /app
  - link "See how it starts":
    - /url: "#run"
  - paragraph: "The brain behind this text is generated live in your browser: 520 nodes, 7 clusters, no server involved."
- heading "One graph for the code you wrote and the documents that explain it." [level=2]
- paragraph: Functions link to the README sections that mention them. Concepts link across PDFs. Every link comes with the evidence behind it.
- heading "Watch the graph grow while it builds" [level=3]
- paragraph: The server streams nodes as they are placed, heaviest first. You see structure appear in seconds instead of staring at a progress bar.
- heading "Hover for the why" [level=3]
- paragraph: Hover any link and read, in plain words, why two things are connected, with the line of code or text that proves it.
- heading "What breaks if I change this?" [level=3]
- paragraph: Pick a function and watch a shock wave travel through everything that depends on it, with a risk rating.
- heading "Follow a call through your code" [level=3]
- paragraph: "Play an execution flow step by step: a pulse walks from the entry point through every function it reaches."
- heading "Answers that light up" [level=3]
- paragraph: Ask a question and the nodes behind the answer fire in order, with numbered citations you can click.
- heading "GitHub, GitLab, a folder, or a PDF" [level=3]
- paragraph: Paste a repo link (private repos with a token), point at a folder on your machine, or drop in documents.
- heading "Your code stays on your computer" [level=3]
- paragraph: The server runs locally. This website is only the window; nothing you analyze is uploaded to it.
- heading "One command, and the page finds your server." [level=2]
- paragraph: "NexMind has two parts: this website and a small server on your computer. Start the server once; the website detects it and connects on its own."
- list:
  - listitem:
    - text: "1"
    - heading "Start the server" [level=3]
    - paragraph: Run the command in the backend folder. The first run installs what it needs.
  - listitem:
    - text: "2"
    - heading "The page connects by itself" [level=3]
    - paragraph: It listens on 127.0.0.1:8000 and turns green the moment the server answers.
  - listitem:
    - text: "3"
    - heading "Pick a repo or documents" [level=3]
    - paragraph: Paste a link, choose a folder or drop files, then watch the graph build.
- tablist "Operating system":
  - tab "Windows" [selected]
  - tab "macOS"
  - tab "Linux"
- text: PowerShell
- 'button "Copy command: powershell -ExecutionPolicy Bypass -File .\\start.ps1"'
- text: $ powershell -ExecutionPolicy Bypass -File .\start.ps1 terminal $ powershell -ExecutionPolicy Bypass -File .\start.ps1 NexMind 1.1.0 → http://127.0.0.1:8000 Web app detected this server Connected to NexMind 1.1.0 Choose what to analyze
- heading "Give your project a brain you can walk through." [level=2]
- link "Open NexMind":
  - /url: /app
- contentinfo: NexMind · repository and document intelligence
- status
```

# Test source

```ts
  1  | import { test, expect } from './fixtures/test-base'
  2  | 
  3  | test.describe('A) Startup and connection', () => {
  4  |   test('cold start with server up goes straight to dashboard without commands gate', async ({ page }) => {
  5  |     await page.goto('/app')
  6  |     // Should see heading for Workspaces or Create your first workspace
  7  |     const heading = page.locator('h1:has-text("Workspaces"), h1:has-text("Create your first workspace")')
  8  |     await expect(heading).toBeVisible({ timeout: 10000 })
  9  | 
  10 |     // "Start your local server" should never appear
  11 |     const gate = page.locator('text="Start your local server"')
  12 |     await expect(gate).not.toBeVisible()
  13 |   })
  14 | 
  15 |   test('deep link to unknown workspace shows friendly error', async ({ page, allowFailedRequest }) => {
  16 |     allowFailedRequest((url, status) => url.includes('/api/workspaces/ws-nonexistent') && (status === 404 || status === 400))
  17 | 
  18 |     await page.goto('/app/w/ws-nonexistent-999')
  19 |     // Verify readable error message / notification
  20 |     await expect(page.locator('text=/Workspace not found|no longer exists|hit a problem/i').first()).toBeVisible({ timeout: 10000 })
  21 |   })
  22 | 
  23 |   test('browser back and forward navigation works smoothly between landing and hub', async ({ page }) => {
  24 |     await page.goto('/')
> 25 |     await expect(page.locator('text=/Explore codebases/i, text=/NexMind/i').first()).toBeVisible()
     |                                                                                      ^ Error: expect(locator).toBeVisible() failed
  26 | 
  27 |     // Navigate to app
  28 |     const openBtn = page.locator('a:has-text("Open the app"), button:has-text("Open the app")').first()
  29 |     await openBtn.click()
  30 | 
  31 |     await expect(page).toHaveURL(/\/app/)
  32 |     await expect(page.locator('h1:has-text("Workspaces"), h1:has-text("Create your first workspace")')).toBeVisible()
  33 | 
  34 |     // Back to landing
  35 |     await page.goBack()
  36 |     await expect(page).toHaveURL(/\/$/)
  37 | 
  38 |     // Forward to app
  39 |     await page.goForward()
  40 |     await expect(page).toHaveURL(/\/app/)
  41 |   })
  42 | })
  43 | 
```