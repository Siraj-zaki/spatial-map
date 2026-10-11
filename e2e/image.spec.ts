import { test, expect } from '@playwright/test'
import { waitForBackendReady, selectTenantIfPrompted } from './test-utils'

// Minimal 1x1 transparent PNG.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test.describe('Image upload', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForBackendReady(page)
    await selectTenantIfPrompted(page)
  })

  test('uploads an image through the layout editor side panel', async ({ page }) => {
    const warehouseName = `E2E Image ${Date.now()}`

    // Create a warehouse.
    await page.getByRole('button', { name: 'Add warehouse' }).first().click()
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /Add warehouse|Create warehouse|New warehouse/i }).first()
    await expect(dialog).toBeVisible()
    await dialog.locator('input').first().fill(warehouseName)
    await dialog.getByRole('button', { name: /Create|Save/i }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByText(warehouseName).first()).toBeVisible()

    // Open the warehouse layout editor.
    const card = page.getByTestId('warehouse-card').filter({ hasText: warehouseName }).first()
    await card.click()
    await expect(page).toHaveURL(/\/create-grids/)

    // Select the image tool.
    await page.getByRole('button', { name: 'Add floor plan' }).click()

    // The side panel should enter image-placement mode.
    await expect(page.getByText('Place a floor plan').first()).toBeVisible()

    // Upload the PNG through the side-panel file picker.
    const fileInput = page.locator('input[type="file"][accept*="image"]').first()
    await fileInput.setInputFiles({
      name: 'e2e-floor-plan.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    })

    // The draft should appear with file name and dimensions.
    await expect(page.getByText('e2e-floor-plan.png')).toBeVisible()
    await expect(page.getByText(/1×1px|1 x 1/i)).toBeVisible()
  })

  test('rotates an uploaded image and persists the change', async ({ page }) => {
    const warehouseName = `E2E Image Rotate ${Date.now()}`

    // Fail fast on any runtime error during interaction. Resource-load failures
    // (e.g. 401s from external basemap tiles) are logged as console errors but
    // do not indicate an SPA bug, so ignore them.
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource:')) {
        throw new Error(`Browser console error: ${msg.text()}`)
      }
    })
    page.on('pageerror', (err) => {
      throw new Error(`Browser page error: ${err.message}`)
    })

    // Create a warehouse and open its layout editor.
    await page.getByRole('button', { name: 'Add warehouse' }).first().click()
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /Add warehouse|Create warehouse|New warehouse/i }).first()
    await expect(dialog).toBeVisible()
    await dialog.locator('input').first().fill(warehouseName)
    await dialog.getByRole('button', { name: /Create|Save/i }).click()
    await expect(dialog).not.toBeVisible()

    const card = page.getByTestId('warehouse-card').filter({ hasText: warehouseName }).first()
    await card.click()
    await expect(page).toHaveURL(/\/create-grids/)

    // Start image placement.
    await page.getByRole('button', { name: 'Add floor plan' }).click()
    await expect(page.getByText('Place a floor plan').first()).toBeVisible()

    const fileInput = page.locator('input[type="file"][accept*="image"]').first()
    await fileInput.setInputFiles({
      name: 'e2e-floor-plan.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    })
    await expect(page.getByText('e2e-floor-plan.png')).toBeVisible()

    // Drag on the map canvas to place the image.
    const mapCanvas = page.locator('.mapboxgl-canvas').first()
    await expect(mapCanvas).toBeVisible()
    const box = await mapCanvas.boundingBox()
    if (!box) throw new Error('Map canvas not found')
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const end = { x: start.x + 60, y: start.y + 40 }
    await mapCanvas.hover({ position: { x: 0, y: 0 } })
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await page.mouse.up()

    // The side panel should now show the saved image in the list.
    const imageRow = page.locator('li[title*="e2e-floor-plan.png"]').first()
    await expect(imageRow).toBeVisible()
    await imageRow.click()

    // Rotate via the slider.
    const rotationSlider = page.locator('span', { hasText: /^Rotation$/i }).locator('..').locator('[role="slider"]').first()
    await expect(rotationSlider).toBeVisible()
    await rotationSlider.fill('45')

    // The rotation readout should update.
    await expect(page.getByText('45°')).toBeVisible()

    // Wait for the debounced backend flush and SSE reconciliation.
    await page.waitForTimeout(800)

    // Reload and verify the rotation persisted.
    await page.reload()
    await expect(page).toHaveURL(/\/create-grids/)
    await imageRow.click()
    await expect(page.getByText('45°')).toBeVisible()
  })
})
