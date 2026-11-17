import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import http from "node:http"
import { readAccounts, startDashboard } from "./dashboard.mjs"

test("dashboard reads only ZGAP OAuth accounts and never exposes credentials", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zgap-dashboard-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "plugin-auth.json"), JSON.stringify({
    zgap: { type: "oauth", access: "access-one", accountId: "one@example.com" },
    "other#one": { type: "oauth", access: "other", accountId: "other@example.com" },
    "zgap#two": { type: "oauth", access: "access-two", accountId: "two@example.com" },
  }))
  const accounts = await readAccounts(dir)
  assert.deepEqual(accounts.map(({ id, label }) => ({ id, label })), [
    { id: createHash("sha256").update("zgap\0one@example.com").digest("hex").slice(0, 20), label: "one@example.com" },
    { id: createHash("sha256").update("zgap#two\0two@example.com").digest("hex").slice(0, 20), label: "two@example.com" },
  ])
  assert.equal(JSON.stringify(accounts.map(({ auth, ...publicAccount }) => publicAccount)).includes("access-one"), false)
  await writeFile(path.join(dir, "settings.json"), JSON.stringify({ noAccountDiscovery: true }))
  assert.deepEqual(await readAccounts(dir), [])
})

test("dashboard proxies usage with the selected OAuth account and opaque page token", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zgap-dashboard-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "plugin-auth.json"), JSON.stringify({ zgap: { type: "oauth", access: "access-one", accountId: "one@example.com" } }))
  const calls = []
  const server = await startDashboard({ directory: dir, port: 0, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), headers: init.headers })
    return new Response(JSON.stringify({ requests: 4, costUsd: 1.25 }), { status: 200, headers: { "content-type": "application/json" } })
  } })
  const port = server.address().port
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`)
    const html = await page.text()
    const token = /zgap-page-token" content="([^"]+)"/.exec(html)?.[1]
    assert.ok(token)
    const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { origin: "null", "x-zgap-page-token": token } })
    assert.equal(session.status, 200)
    const account = (await session.json()).accounts[0].id
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/session`)).status, 403)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { origin: "https://evil.example", "x-zgap-page-token": token } })).status, 403)
    const hostileHost = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}/api/session`, { headers: { host: "evil.example", "x-zgap-page-token": token } }, response => { response.resume(); resolve(response.statusCode) }).on("error", reject))
    assert.equal(hostileHost, 403)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/usage?account=other`, { headers: { "x-zgap-page-token": token } })).status, 401)
    const usage = await fetch(`http://127.0.0.1:${port}/api/usage?account=${account}&days=7`, { headers: { origin: "null", "x-zgap-page-token": token } })
    assert.equal(usage.status, 200)
    assert.equal(calls[0].headers.authorization, "Bearer access-one")
    assert.equal(calls[0].url, "https://ai-proxy.zz.gg/v1/dashboard?days=7&timeZone=UTC")
    assert.equal(JSON.stringify(await usage.json()).includes("access-one"), false)
  } finally { server.close() }
})

test("sign-out during an upstream request discards its response", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zgap-dashboard-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "plugin-auth.json"), JSON.stringify({ zgap: { type: "oauth", access: "private-token" } }))
  const server = await startDashboard({ directory: dir, port: 0, fetchImpl: async () => {
    await writeFile(path.join(dir, "plugin-auth.json"), "{}")
    return Response.json({ requests: 42 })
  } })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const token = /zgap-page-token" content="([^"]+)"/.exec(await (await fetch(base)).text())[1]
  const result = await fetch(`${base}/api/live`, { headers: { "x-zgap-page-token": token } })
  assert.equal(result.status, 401)
  assert.deepEqual(await result.json(), { error: "session_changed" })
})
