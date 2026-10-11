import { test, expect, Page } from '@playwright/test'

/**
 * Signup flow. Every backend call is mocked via page.route so the test
 * doesn't need SMTP or a fresh Postgres — it exercises the state machine,
 * URL sync, and error-recovery paths in isolation.
 *
 * The mocks return the same envelope shape (`{ data: T }` or `{ error }`)
 * the real backend uses so unauthenticatedJson unwraps them identically.
 */

async function stubAuthMe(page: Page) {
  // Kill the initial /auth/me probe so the test starts unauthenticated
  // without waiting on the real backend.
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not authenticated' }),
    }),
  )
}

test.describe('Signup flow', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.clearCookies()
    await stubAuthMe(page)
  })

  test('happy path walks all three steps and mirrors step+email in the URL', async ({ page }) => {
    await page.route('**/api/v1/auth/signup-request', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { ok: true, email: 'new-user@example.com', expiresIn: 600 },
        }),
      }),
    )
    await page.route('**/api/v1/auth/verify-otp', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            verificationToken: 'v-token-abc',
            email: 'new-user@example.com',
            expiresAt: '2100-01-01T00:00:00Z',
          },
        }),
      }),
    )
    await page.route('**/api/v1/auth/complete-signup', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            token: 'session-jwt',
            user: { id: 1, email: 'new-user@example.com', displayName: '', bio: '', location: '', pronouns: '', jobTitle: '', avatarUrl: '' },
            tenants: [{ id: 1, name: 'test workspace', color: '#3b82f6', role: 'owner' }],
          },
        }),
      }),
    )

    await page.goto('/signup')
    await expect(page).not.toHaveURL(/step=/)

    await page.getByLabel('Email').fill('new-user@example.com')
    await page.getByRole('button', { name: 'Send verification code' }).click()

    await page.waitForURL(/step=otp/)
    expect(page.url()).toContain('email=new-user%40example.com')
    await expect(page.getByLabel('Verification code')).toBeVisible()

    await page.getByLabel('Verification code').fill('123456')
    await page.getByRole('button', { name: 'Verify code' }).click()

    // Password step. URL should keep step=otp — never step=password —
    // because the verification token isn't persistable.
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
    expect(page.url()).toMatch(/step=otp/)
    expect(page.url()).not.toMatch(/step=password/)
  })

  test('landing at ?step=otp WITH email keeps the user on step 2', async ({ page }) => {
    await page.goto('/signup?step=otp&email=known@example.com')
    await expect(page.getByLabel('Verification code')).toBeVisible()
    await expect(page.getByText('known@example.com')).toBeVisible()
  })

  test('landing at ?step=otp WITHOUT email falls back to step 1', async ({ page }) => {
    await page.goto('/signup?step=otp')
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Verification code')).not.toBeVisible()
  })

  test('signup-request treats existing + new emails identically (no user enumeration)', async ({ page }) => {
    // Post-hardening: backend returns 200 for BOTH existing and new emails
    // (with the same envelope). The 409 code path is dead — a caller can
    // no longer distinguish "email exists" from "email is new" via the
    // signup-request response.
    await page.route('**/api/v1/auth/signup-request', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ok: true, email: 'anyone@example.com', expiresIn: 600 } }),
      }),
    )

    await page.goto('/signup')
    await page.getByLabel('Email').fill('anyone@example.com')
    await page.getByRole('button', { name: 'Send verification code' }).click()

    // Both existing and new emails land on step 2; no sign-in-link, no
    // enumeration signal.
    await page.waitForURL(/step=otp/)
    await expect(page.getByLabel('Verification code')).toBeVisible()
    await expect(page.getByRole('link', { name: /Sign in instead/i })).not.toBeVisible()
  })

  test('race-case 409 on complete-signup still shows Sign in link', async ({ page }) => {
    // If someone else signs up with the same email between the OTP verify
    // and the password submit, the backend returns 409 — the frontend
    // must surface the sign-in link so the user isn't stuck.
    await page.route('**/api/v1/auth/signup-request', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ok: true, email: 'race@example.com', expiresIn: 600 } }),
      }),
    )
    await page.route('**/api/v1/auth/verify-otp', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { verificationToken: 'v-token', email: 'race@example.com', expiresAt: '2100-01-01' },
        }),
      }),
    )
    await page.route('**/api/v1/auth/complete-signup', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'an account with this email already exists' }),
      }),
    )

    await page.goto('/signup')
    await page.getByLabel('Email').fill('race@example.com')
    await page.getByRole('button', { name: 'Send verification code' }).click()
    await page.waitForURL(/step=otp/)
    await page.getByLabel('Verification code').fill('123456')
    await page.getByRole('button', { name: 'Verify code' }).click()
    await page.getByLabel('Password', { exact: true }).fill('MyStr0ng!Passphrase')
    await page.getByLabel('Confirm password').fill('MyStr0ng!Passphrase')
    await page.getByRole('button', { name: /Create an account/i }).click()

    await expect(page.getByText('an account with this email already exists')).toBeVisible()
  })

  test('401 on complete-signup snaps back to step 1 with expired-window banner', async ({ page }) => {
    await page.route('**/api/v1/auth/signup-request', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ok: true, email: 'test@example.com', expiresIn: 600 } }),
      }),
    )
    await page.route('**/api/v1/auth/verify-otp', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { verificationToken: 'v-token', email: 'test@example.com', expiresAt: '2100-01-01' },
        }),
      }),
    )
    await page.route('**/api/v1/auth/complete-signup', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'verification token invalid or expired — please verify your email again',
        }),
      }),
    )

    await page.goto('/signup')
    await page.getByLabel('Email').fill('test@example.com')
    await page.getByRole('button', { name: 'Send verification code' }).click()
    await page.waitForURL(/step=otp/)

    await page.getByLabel('Verification code').fill('123456')
    await page.getByRole('button', { name: 'Verify code' }).click()

    await page.getByLabel('Password', { exact: true }).fill('MyStr0ng!Passphrase')
    await page.getByLabel('Confirm password').fill('MyStr0ng!Passphrase')
    await page.getByRole('button', { name: /Create an account/i }).click()

    // Should snap back to step 1 (no ?step= in URL) with the info banner.
    await expect(page).not.toHaveURL(/step=otp/)
    await expect(page.getByText(/verification window expired/i)).toBeVisible()
    await expect(page.getByLabel('Email')).toBeVisible()
  })

  test('Wrong email? button resets to step 1 and clears the URL step', async ({ page }) => {
    await page.route('**/api/v1/auth/signup-request', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ok: true, email: 'oops@example.com', expiresIn: 600 } }),
      }),
    )

    await page.goto('/signup')
    await page.getByLabel('Email').fill('oops@example.com')
    await page.getByRole('button', { name: 'Send verification code' }).click()
    await page.waitForURL(/step=otp/)

    await page.getByRole('button', { name: /Wrong email/i }).click()
    await expect(page).not.toHaveURL(/step=/)
    await expect(page.getByLabel('Email')).toBeVisible()
  })
})
