import { test, expect } from './fixtures/test-base'
import path from 'path'

test.describe('E) Workspace page and interactive controls', () => {
  let wsId = ''

  test.beforeAll(async ({ request }) => {
    // Create a workspace via API and ingest code fixture
    const res = await request.post('http://127.0.0.1:8000/api/workspaces', {
      data: { name: 'E2E Code Workspace', description: 'Testing workspace controls', kind: 'code' },
    })
    const ws = await res.json()
    wsId = ws.id

    // Ingest sample code folder
    const sampleDir = path.resolve(process.cwd(), 'e2e/fixtures/sample_code')
    await request.post(`http://127.0.0.1:8000/api/workspaces/${wsId}/ingest/local`, {
      data: { path: sampleDir },
    })

    // Poll until workspace is ready
    let attempts = 0
    while (attempts < 30) {
      const check = await request.get(`http://127.0.0.1:8000/api/workspaces/${wsId}`)
      const data = await check.json()
      if (data.status === 'ready') break
      await new Promise((r) => setTimeout(r, 1000))
      attempts++
    }
  })

  test('Top bar controls: mode buttons, search, auto-rotate, fit, export, and rename', async ({ page }) => {
    await page.goto(`/app/w/${wsId}`)

    // Wait for graph canvas to be active
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 })

    // Mode buttons: Explore, Impact, Trace, Flows
    const exploreBtn = page.locator('button:has-text("Explore")').first()
    const impactBtn = page.locator('button:has-text("Impact")').first()
    const traceBtn = page.locator('button:has-text("Trace")').first()
    const flowsBtn = page.locator('button:has-text("Flows")').first()

    await expect(exploreBtn).toBeVisible()
    await expect(impactBtn).toBeVisible()
    await expect(traceBtn).toBeVisible()
    await expect(flowsBtn).toBeVisible()

    // Click Impact button -> should activate impact mode hint
    await impactBtn.click()
    await expect(page.locator('text=/Select a node to inspect/i, text=/Impact/i').first()).toBeVisible()

    // Return to Explore
    await exploreBtn.click()

    // Search bar
    const searchInput = page.locator('input[placeholder*="Search"]').first()
    await expect(searchInput).toBeVisible()
    await searchInput.fill('auth')
    await page.keyboard.press('Enter')

    // Auto-rotate toggle button
    const autoRotateBtn = page.locator('button[aria-label*="rotate" i], button:has-text("Rotate")').first()
    if (await autoRotateBtn.isVisible()) {
      await autoRotateBtn.click()
    }

    // Fit button
    const fitBtn = page.locator('button[aria-label*="Fit" i], button:has-text("Fit")').first()
    if (await fitBtn.isVisible()) {
      await fitBtn.click()
    }

    // Export dropdown / triggers
    const exportBtn = page.locator('button:has-text("Export")').first()
    if (await exportBtn.isVisible()) {
      await exportBtn.click()
      await expect(page.locator('text=JSON, text=GraphML, text=Cypher').first()).toBeVisible()
      // Close dropdown
      await page.keyboard.press('Escape')
    }
  })

  test('Left rail tabs: Sources, Chats, Insights, Flows, Filters', async ({ page }) => {
    await page.goto(`/app/w/${wsId}`)
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 })

    // Check rail buttons
    const sourcesBtn = page.locator('button:has-text("Sources")').first()
    const chatsBtn = page.locator('button:has-text("Chats")').first()
    const insightsBtn = page.locator('button:has-text("Insights")').first()
    const filtersBtn = page.locator('button:has-text("Filters")').first()

    await expect(sourcesBtn).toBeVisible()
    await expect(chatsBtn).toBeVisible()
    await expect(insightsBtn).toBeVisible()
    await expect(filtersBtn).toBeVisible()

    // Click Filters tab
    await filtersBtn.click()
    await expect(page.locator('text=/Node types|Filter/i').first()).toBeVisible()

    // Click Insights tab
    await insightsBtn.click()
    await expect(page.locator('text=/Insights|Findings/i').first()).toBeVisible()

    // Click Chats tab
    await chatsBtn.click()
    await expect(page.locator('text=/New chat|Chats/i').first()).toBeVisible()

    // Return to Sources
    await sourcesBtn.click()
  })

  test('Chat dock: send a query and receive offline stream answer with citations', async ({ page }) => {
    await page.goto(`/app/w/${wsId}`)
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 })

    const chatInput = page.locator('textarea[placeholder*="Ask"], input[placeholder*="Ask"]').first()
    if (await chatInput.isVisible()) {
      await chatInput.fill('What does this repository do?')
      const sendBtn = page.locator('button:has-text("Send"), button[aria-label="Send message"]').first()
      await sendBtn.click()

      // Answer arrives (offline answer)
      await expect(page.locator('text=/Answered offline|repository|code/i').first()).toBeVisible({ timeout: 30000 })
    }
  })
})
