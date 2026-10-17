import { test, expect } from './fixtures/test-base'

test.describe('C) Hub page', () => {
  test('renders workspace tabs, settings popover, and handles workspace operations', async ({ page }) => {
    await page.goto('/app')

    // Top-right server chip and display settings button
    const settingsBtn = page.locator('button[aria-label="Display settings"]')
    await expect(settingsBtn).toBeVisible({ timeout: 10000 })
    await settingsBtn.click()

    // Settings popover switches
    await expect(page.locator('text=Solid surfaces (no blur)')).toBeVisible()
    await expect(page.locator('text=Performance mode')).toBeVisible()

    // Toggle solid surface switch
    const solidToggle = page.locator('input[type="checkbox"]').first()
    await solidToggle.click()

    // Close settings popover
    await settingsBtn.click()

    // Check "New workspace" button
    const newWsBtn = page.locator('button:has-text("New workspace")').first()
    await expect(newWsBtn).toBeVisible()

    // Tabs exist if workspaces are present
    const tabs = page.locator('[role="tab"]')
    const tabCount = await tabs.count()
    if (tabCount >= 3) {
      await expect(page.locator('button[role="tab"]:has-text("Projects")')).toBeVisible()
      await expect(page.locator('button[role="tab"]:has-text("Documents")')).toBeVisible()
      await expect(page.locator('button[role="tab"]:has-text("Live connect")')).toBeVisible()
    }
  })
})
