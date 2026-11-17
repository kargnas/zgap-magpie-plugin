import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  use: { viewport: { width: 1100, height: 1100 } },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
})
