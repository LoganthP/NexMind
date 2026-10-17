import { test, expect } from './fixtures/test-base'

test.describe('A) Startup and connection', () => {
  test('cold start with server up goes straight to dashboard without commands gate', async ({ page }) => {
    await page.goto('/app')
    // Should see heading for Workspaces or Create your first workspace
    const heading = page.locator('h1:has-text("Workspaces"), h1:has-text("Create your first workspace")')
    await expect(heading).toBeVisible({ timeout: 10000 })

    // "Start your local server" should never appear
    const gate = page.locator('text="Start your local server"')
    await expect(gate).not.toBeVisible()
  })

  test('deep link to unknown workspace shows friendly error', async ({ page, allowFailedRequest }) => {
    allowFailedRequest((url, status) => url.includes('/api/workspaces/ws-nonexistent') && (status === 404 || status === 400))

    await page.goto('/app/w/ws-nonexistent-999')
    // Verify readable error message / notification
    await expect(page.locator('text=/Workspace not found|no longer exists|hit a problem/i').first()).toBeVisible({ timeout: 10000 })
  })

  test('browser back and forward navigation works smoothly between landing and hub', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=/Explore codebases/i, text=/NexMind/i').first()).toBeVisible()

    // Navigate to app
    const openBtn = page.locator('a:has-text("Open the app"), button:has-text("Open the app")').first()
    await openBtn.click()

    await expect(page).toHaveURL(/\/app/)
    await expect(page.locator('h1:has-text("Workspaces"), h1:has-text("Create your first workspace")')).toBeVisible()

    // Back to landing
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)

    // Forward to app
    await page.goForward()
    await expect(page).toHaveURL(/\/app/)
  })
})
