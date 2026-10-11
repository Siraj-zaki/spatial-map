import { test, expect } from '@playwright/test'
import { navigateTo, waitForBackendReady } from './test-utils'

test.describe('Smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForBackendReady(page)
  })

  test('landing page shows navigation and warehouses tab', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Warehouses' }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: 'Layout Editor' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Integrations' })).toBeVisible()
  })

  test('can navigate to layout editor and integrations', async ({ page }) => {
    await navigateTo(page, 'Layout Editor')
    await expect(page).toHaveURL(/\/create-grids/)
    await expect(page.getByText('No warehouse selected')).toBeVisible()

    await navigateTo(page, 'Integrations')
    await expect(page).toHaveURL(/\/integrations/)
    await expect(page.getByRole('heading', { name: 'Integrations' }).first()).toBeVisible()
  })
})
