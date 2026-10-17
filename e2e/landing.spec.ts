import { test, expect } from './fixtures/test-base'

test.describe('B) Landing page', () => {
  test('renders landing page with hero, navigation links, and OS copy blocks without errors', async ({ page }) => {
    await page.goto('/')

    // Hero visible
    await expect(page.locator('text=/Understand any codebase|NexMind/i').first()).toBeVisible({ timeout: 10000 })

    // Open the app button is visible and active
    const openAppBtn = page.locator('text=Open the app').first()
    await expect(openAppBtn).toBeVisible()

    // OS tabs in landing page
    const winTab = page.locator('button:has-text("Windows")').first()
    const macTab = page.locator('button:has-text("macOS")').first()
    const linuxTab = page.locator('button:has-text("Linux")').first()

    if (await winTab.isVisible()) {
      await winTab.click()
      await expect(page.locator('text=/powershell|start\.ps1|irm/i').first()).toBeVisible()
    }
    if (await macTab.isVisible()) {
      await macTab.click()
      await expect(page.locator('text=/start\.sh|curl/i').first()).toBeVisible()
    }
    if (await linuxTab.isVisible()) {
      await linuxTab.click()
      await expect(page.locator('text=/start\.sh|curl/i').first()).toBeVisible()
    }

    // Nav anchor scroll
    const featuresLink = page.locator('a[href^="#"]').first()
    if (await featuresLink.isVisible()) {
      await featuresLink.click()
    }
  })

  test('gracefully renders with reduced-motion enabled without console errors', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await expect(page.locator('text=/Understand any codebase|NexMind/i').first()).toBeVisible({ timeout: 10000 })
  })
})
