import { test, expect } from "@playwright/test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { startDashboard } from "../dashboard.mjs"

test("sandboxed dashboard transitions between sign-in, data, errors and sign-out", async ({ page }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-page-"))
  const credentials = path.join(directory, "plugin-auth.json")
  let fail = false
  const calls = []
  const service = await startDashboard({ directory, port: 0, fetchImpl: async (url, init) => {
    calls.push({ days: url.searchParams.get("days"), authorization: init.headers.authorization })
    if (fail) return Response.json({ error: "unavailable" }, { status: 503 })
    if (url.pathname.endsWith("/live")) return Response.json({ email: "fixture@example.com", inflight: [{ model: "publisher/active", state: "streaming" }], recent: [] })
    return Response.json({ email: "fixture@example.com", requests: 12, inputTokens: 123456, outputTokens: 12345, costUsd: null, incomplete: true,
      days: [{ date: "2026-11-17", requests: 12 }], models: [{ model: "publisher/sample", requests: 12, outputTokens: 12345, costUsd: null }] })
  } })
  const parent = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end(`<!doctype html><style>body{margin:0}iframe{width:100%;height:1500px;border:0}</style>
      <script>addEventListener('message',e=>{if(e.data.method==='hello')e.source.postMessage({magpie:1,id:e.data.id,result:{dark:false,lang:'en',visible:true}},'*')})</script>
      <iframe sandbox="allow-scripts" src="http://127.0.0.1:${service.address().port}/"></iframe>`)
  })
  await new Promise(resolve => parent.listen(0, "127.0.0.1", resolve))
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${parent.address().port}/`)
    const frame = page.frameLocator("iframe")
    await expect(frame.locator("#headline")).toBeVisible()
    await expect(frame.locator("#activity")).toBeHidden()
    await writeFile(credentials, JSON.stringify({ zgap: { type: "oauth", access: "test-token", accountId: "fixture@example.com" } }))
    // Returning to the tab refreshes authentication without waiting for the polling interval.
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ magpie: 1, event: 'visibility', data: { visible: true } }, '*'))
    await expect(frame.locator("#activity")).toBeVisible()
    await expect(frame.locator("#headline")).toBeHidden()
    await expect(frame.locator("#requests")).toHaveText("12")
    await expect(frame.locator("#cost")).toHaveText("—")
    await expect(frame.locator("#live-rows")).toContainText("publisher/active")
    await frame.locator('[data-days="30"]').click()
    await expect.poll(() => calls.some(call => call.days === "30")).toBe(true)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => frame.locator('body').evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true)
    fail = true
    await frame.locator("#refresh").click()
    await expect(frame.locator("#usage-error")).toBeVisible()
    await expect(frame.locator("#usage-content")).toBeHidden()
    await expect(frame.locator("#live-rows tr")).toHaveCount(0)
    await writeFile(credentials, "{}")
    await frame.locator("#refresh").click()
    await expect(frame.locator("#activity")).toBeHidden()
    await expect(frame.locator("#headline")).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await page.goto("about:blank")
    parent.closeAllConnections(); service.closeAllConnections()
    await Promise.all([new Promise(resolve => parent.close(resolve)), new Promise(resolve => service.close(resolve))])
    await rm(directory, { recursive: true, force: true })
  }
})
