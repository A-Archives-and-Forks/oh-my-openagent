import { test, expect } from "@playwright/test"

test.describe("Landing Page", () => {
  test("renders hero section with title and CTA", async ({ page }) => {
    // given
    await page.goto("/")

    // when
    const heading = page.getByRole("heading", { name: "The Best Agent Harness", level: 1 })
    const getStartedButton = page.getByRole("button", { name: "Get Started" })

    // then
    await expect(page).toHaveTitle(/Oh My OpenAgent/)
    await expect(heading).toBeVisible()
    await expect(getStartedButton).toBeVisible()
  })

  test("renders install command", async ({ page }) => {
    // given
    await page.goto("/")

    // when
    const installCommand = page.getByText("bunx oh-my-openagent install").first()

    // then
    await expect(installCommand).toBeVisible()
  })

  test("renders all rendered agent cards", async ({ page }) => {
    // given
    await page.goto("/")

    // when / then
    const agentNames = [
      "Sisyphus",
      "Hephaestus",
      "Oracle",
      "Librarian",
      "Explore",
      "Prometheus",
      "Metis",
      "Momus",
      "Atlas",
    ]
    for (const name of agentNames) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
    }
  })

  test("mobile nav toggles menu", async ({ page }) => {
    // given
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto("/")

    const mobileNav = page.locator("#mobile-nav")
    await expect(mobileNav).toBeHidden()

    // when
    await page.getByRole("button", { name: "Open menu" }).click()

    // then
    await expect(mobileNav).toBeVisible()
    await expect(mobileNav.getByRole("link", { name: "Docs", exact: true })).toBeVisible()
    await expect(mobileNav.getByRole("link", { name: "Manifesto", exact: true })).toBeVisible()
  })

  test("navigates to docs page", async ({ page }) => {
    // given
    await page.goto("/")

    // when
    await Promise.all([
      page.waitForURL("**/docs", { timeout: 15000 }),
      page.getByRole("navigation").getByRole("link", { name: "Docs", exact: true }).click(),
    ])

    // then
    await expect(page).toHaveURL(/\/docs/)
    await expect(page.getByRole("heading", { name: "Configuration Reference" })).toBeVisible()
  })

  test("navigates to manifesto page", async ({ page }) => {
    // given
    await page.goto("/")

    // when
    await Promise.all([
      page.waitForURL("**/manifesto", { timeout: 15000 }),
      page.getByRole("navigation").getByRole("link", { name: "Manifesto", exact: true }).click(),
    ])

    // then
    await expect(page).toHaveURL(/\/manifesto/)
    await expect(page.getByRole("heading", { name: "Ultrawork Manifesto" })).toBeVisible()
  })
})
