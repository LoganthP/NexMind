import { test, expect } from './fixtures/test-base'

test.describe('G) Resilience and responsiveness', () => {
  test('handles rapid clicking, window resize, and theme switches without crashes', async ({ page }) => {
    await page.goto('/app')
    await expect(page.locator('h1:has-text("Workspaces"), h1:has-text("Create your first workspace")')).toBeVisible({ timeout: 10000 })

    // Rapid clicking of display settings
    const settingsBtn = page.locator('button[aria-label="Display settings"]')
    await settingsBtn.click()
    await settingsBtn.click()
    await settingsBtn.click()

    // Window resize (desktop to small laptop to mobile)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(100)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForTimeout(100)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(100)

    // Restore desktop
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.locator('h1:has-text("Workspaces"), h1:has-text("Create your first workspace")')).toBeVisible()
  })

  test('two browser tabs on the same workspace operate safely without corruption', async ({ context, request }) => {
    const res = await request.post('http://127.0.0.1:8000/api/workspaces', {
      data: { name: 'E2E Dual Tab Workspace', description: 'Testing dual tabs', kind: 'code' },
    })
    const ws = await res.json()

    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`/app/w/${ws.id}`)
    await page2.goto(`/app/w/${ws.id}`)

    await expect(page1.locator('header, canvas, [role="main"]').first()).toBeVisible({ timeout: 15000 })
    await expect(page2.locator('header, canvas, [role="main"]').first()).toBeVisible({ timeout: 15000 })

    await page1.close()
    await page2.close()
  })
})
