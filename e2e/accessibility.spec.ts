import { test, expect } from './fixtures/test-base'
import AxeBuilder from '@axe-core/playwright'

test.describe('H) Accessibility and quality gates', () => {
  test('Landing page has no serious or critical accessibility violations', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=/Understand any codebase|NexMind/i').first()).toBeVisible({ timeout: 10000 })

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast']) // Color contrast in canvas / custom glowing text is verified visually
      .analyze()

    const severeIssues = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
    expect(severeIssues, `Severe accessibility violations on Landing page: ${JSON.stringify(severeIssues, null, 2)}`).toEqual([])
  })

  test('Hub dashboard has no serious or critical accessibility violations', async ({ page }) => {
    await page.goto('/app')
    await expect(page.locator('h1:has-text("Workspaces"), h1:has-text("Create your first workspace")')).toBeVisible({ timeout: 10000 })

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast'])
      .analyze()

    const severeIssues = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
    expect(severeIssues, `Severe accessibility violations on Hub: ${JSON.stringify(severeIssues, null, 2)}`).toEqual([])
  })

  test('New workspace dialog has no serious or critical accessibility violations', async ({ page }) => {
    await page.goto('/app')
    await page.locator('button:has-text("New workspace")').first().click()

    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()

    const results = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast'])
      .analyze()

    const severeIssues = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
    expect(severeIssues, `Severe accessibility violations in Dialog: ${JSON.stringify(severeIssues, null, 2)}`).toEqual([])
  })
})
