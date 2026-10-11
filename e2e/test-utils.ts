import { Page, expect } from '@playwright/test'

/**
 * Shared helpers for E2E tests.
 */

export async function waitForBackendReady(page: Page, timeout = 30_000) {
  await expect(page.locator('text=Warehouse Manager').first()).toBeVisible({ timeout })
}

const NAV_PATHS: Record<string, string | RegExp> = {
  'Warehouses': '/dashboard',
  'Layout Editor': '/create-grids',
  'Integrations': '/integrations',
}

export async function navigateTo(page: Page, label: 'Warehouses' | 'Layout Editor' | 'Integrations') {
  const nav = page.locator('nav').first()
  await nav.getByRole('link', { name: label }).click()
  await page.waitForURL(NAV_PATHS[label], { waitUntil: 'domcontentloaded' })
}

export async function selectTenantIfPrompted(page: Page, tenantName = 'E2E Default') {
  const tenantSwitcher = page.locator('[aria-label="Switch tenant"], button:has-text("Tenant")').first()
  if (await tenantSwitcher.isVisible().catch(() => false)) {
    await tenantSwitcher.click()
    await page.getByRole('menuitem', { name: tenantName }).click()
  }
}

/**
 * Create a warehouse from the dashboard. The dashboard shows an "Add warehouse"
 * button in both the header and the empty state; this helper targets the first
 * visible one.
 */
export async function createWarehouse(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add warehouse' }).first().click()

  const dialog = page.locator('[role="dialog"]').filter({ hasText: /Add warehouse|Create warehouse|New warehouse/i }).first()
  await expect(dialog).toBeVisible()
  await dialog.locator('input').first().fill(name)
  await dialog.getByRole('button', { name: /Create|Save/i }).click()
  await expect(dialog).not.toBeVisible()
}
