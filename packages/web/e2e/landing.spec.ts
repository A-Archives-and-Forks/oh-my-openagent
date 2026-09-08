import { test, expect } from "@playwright/test"

test.describe("Landing Page", () => {
  test("renders hero section with title and CTA", async ({ page }) => {
    // given
    await page.goto("/")

    // when
    const heading = page.getByRole("heading", { name: /Type mass ulw\./, level: 1 })
    const getStarted = page.getByRole("link", { name: "Get started" })
    const readManifesto = page.getByRole("link", { name: "Read the manifesto" })

    // then
    await expect(page).toHaveTitle(/Oh My OpenAgent/)
    await expect(heading).toBeVisible()
    await expect(heading).toContainText("Own the graph.")
    await expect(getStarted).toBeVisible()
    await expect(getStarted).toHaveAttribute("href", /\/docs#installation$/)
    await expect(readManifesto).toBeVisible()
  })

  test("renders install command with host tabs", async ({ page }) => {
    // given
    await page.goto("/")
    const hero = page.locator('[data-section="hero"]')

    // when
    const installCommand = hero.getByText("bunx oh-my-openagent install")

    // then
    await expect(installCommand).toBeVisible()
    await expect(hero.getByRole("button", { name: "Copy install command" })).toBeVisible()

    // when
    await hero.getByRole("tab", { name: "Codex" }).click()

    // then
    await expect(hero.getByText("npx lazycodex-ai install")).toBeVisible()

    // when
    await hero.getByRole("tab", { name: "Senpi" }).click()

    // then
    await expect(hero.getByText("npm i -g omo-ai@beta")).toBeVisible()
  })

  test("renders the agent bento cells", async ({ page }) => {
    // given
    await page.goto("/")
    const grid = page.locator("#agents ul")

    // when / then
    await expect(grid.locator("li[id^='agent-']")).toHaveCount(12)
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
      "Sisyphus-Junior",
      "Multimodal-Looker",
    ]
    for (const name of agentNames) {
      await expect(grid.getByRole("heading", { name, exact: true })).toBeVisible()
    }
    await expect(grid.getByText("Claude Opus 5 Max")).toBeVisible()
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
      page.getByRole("banner").getByRole("link", { name: "Docs", exact: true }).click(),
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
      page.getByRole("banner").getByRole("link", { name: "Manifesto", exact: true }).click(),
    ])

    // then
    await expect(page).toHaveURL(/\/manifesto/)
    await expect(page.getByRole("heading", { name: "Ultrawork Manifesto" })).toBeVisible()
  })
})
