import { test, expect } from "@playwright/test"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { startDashboard } from "../dashboard.mjs"

test("the console guide, live events and filtered account statistics work in Magpie's opaque frame", async ({ page }, info) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zgap-console-"))
  const credentials = path.join(dir, "plugin-auth.json")
  const account = name => ({ type: "oauth", access: "fixture-token-" + name, accountId: name + "@example.test" })
  const calls = [], errors = []
  let deny = false, assetsUnavailable = true
  const streams = new Map()
  const service = await startDashboard({ directory: dir, port: 0, fetchImpl: async (url, init) => {
    const file = path.basename(url.pathname)
    if (url.pathname.startsWith("/v1/dashboard/ui/")) {
      expect(init.headers).toBeUndefined()
      if (assetsUnavailable) return new Response(null, { status: 503 })
      if (!info.config.metadata.consoleBuild) return fetch(url, init)
      return new Response(await readFile(path.join(info.config.metadata.consoleBuild, file)), { headers: { "content-type": file.endsWith(".css") ? "text/css" : "text/javascript" } })
    }
    const name = init.headers.authorization.split("-").at(-1)
    calls.push({ file, name, params: url.searchParams })
    if (deny) return Response.json({ error: "invalid_token" }, { status: 401 })
    if (file === "events") {
      return new Response(new ReadableStream({
        start(controller) {
          const event = (type, data) => controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
          streams.set(name, event)
          event("snapshot", { inflight: [], recent: [] })
        },
      }), { headers: { "content-type": "text/event-stream" } })
    }
    if (file === "account-equivalents") return Response.json({ days: 7, providers: [] })
    expect(file).toBe("usage-stats")
    const axis = url.searchParams.get("groupBy"), bucket = url.searchParams.get("bucket")
    const row = { [axis]: name + "-fixture", model: "fixture/model", requests: 12, input_tokens: 100, output_tokens: 40,
      cache_read_tokens: 0, cache_write_tokens: 0, bucket_start: url.searchParams.get("from") }
    return Response.json({ groupBy: [axis], bucket, rows: [row], costRows: null, costSampled: false, filters: [],
      from: url.searchParams.get("from"), to: url.searchParams.get("to"), timeZone: "UTC", prices: {}, thresholds: [] })
  } })
  const parent = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html")
    res.end(`<!doctype html><style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style><script>
      addEventListener('message',e=>{if(e.data.method==='hello')e.source.postMessage({magpie:1,id:e.data.id,result:{dark:false,lang:'en',visible:true}},'*')})</script>
      <iframe title="ZGAP" sandbox="allow-scripts" src="http://127.0.0.1:${service.address().port}/"></iframe>`)
  })
  await new Promise(resolve => parent.listen(0, "127.0.0.1", resolve))
  const message = (event, data) => page.evaluate(([event, data]) => document.querySelector('iframe').contentWindow.postMessage({ magpie: 1, event, data }, '*'), [event, data])
  page.on("pageerror", err => errors.push(err.message))
  const browserRequests = []
  page.on("request", req => browserRequests.push([req.url(), req.headers()]))
  try {
    await page.goto(`http://127.0.0.1:${parent.address().port}`)
    const f = page.frameLocator("iframe")
    await expect(f.getByRole("alert")).toBeVisible()
    assetsUnavailable = false
    await f.getByRole("button", { name: "Refresh" }).click()
    await expect(f.getByRole("heading", { name: "Connect with magpie" })).toBeVisible()
    await expect(f.getByRole("button", { name: "Usage stats" })).toHaveCount(0)
    await message("action", { id: "agent-setup", agent: { name: "Test agent" } })
    await expect(f.locator("#magpie-connectAgent")).toBeFocused()
    await message("visibility", { visible: false })
    await writeFile(credentials, JSON.stringify({ zgap: account("first"), "zgap#2": account("second") }))
    await message("visibility", { visible: true })
    const live = f.getByRole("button", { name: "Live activity" }), stats = f.getByRole("button", { name: "Usage stats" })
    await expect(live).toHaveAttribute("aria-pressed", "true")
    await expect(f.getByText("My request river", { exact: true })).toBeVisible()
    await expect.poll(() => streams.has("first")).toBe(true)
    streams.get("first")("start", { id: "fixture-live", model: "fixture-live-model", tsStart: Date.now(), state: "streaming", sourceLabel: "Fixture" })
    await expect(f.getByRole("combobox", { name: "Filter by model" }).locator("option", { hasText: "fixture-live-model" })).toHaveCount(1)
    await stats.click()
    await expect(f.locator("tbody")).toContainText("first-fixture")
    await f.getByRole("button", { name: "30d" }).click()
    await expect.poll(() => calls.some(c => c.name === "first" && c.params.get("bucket") === "day")).toBe(true)
    await f.getByRole("button", { name: "Requests", exact: true }).click()
    await expect(f.locator(".recharts-surface").first()).toBeVisible()
    await message("theme", { dark: false, lang: "ja" })
    await expect(f.getByText("内訳", { exact: true })).toBeVisible()
    await message("theme", { dark: false, lang: "en" })
    await f.getByRole("combobox", { name: "Account", exact: true }).selectOption({ label: "second@example.test" })
    await stats.click()
    await expect(f.locator("tbody")).toContainText("second-fixture")
    await expect(f.locator("body")).not.toContainText("first-fixture")
    await message("theme", { dark: true, lang: "ko" })
    await expect(f.locator("html")).toHaveClass(/dark/)
    await expect(f.getByRole("button", { name: "사용 통계" })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => f.locator("body").evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true)
    deny = true
    await f.getByRole("group", { name: /기간/ }).getByRole("button").last().click()
    await expect(f.locator("#magpie-signIn")).toBeVisible()
    await expect(f.locator("tbody")).toHaveCount(0)
    await writeFile(credentials, "{}")
    await message("visibility", { visible: false })
    await message("visibility", { visible: true })
    await expect(f.getByRole("combobox", { name: "계정" })).toHaveCount(0)
    expect(browserRequests.every(([url, headers]) => !url.includes("fixture-token") && !headers.authorization)).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await page.goto("about:blank")
    parent.closeAllConnections(); service.closeAllConnections()
    await Promise.all([new Promise(r => parent.close(r)), new Promise(r => service.close(r))])
    await rm(dir, { recursive: true, force: true })
  }
})
