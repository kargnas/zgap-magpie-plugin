import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { readAccounts, startDashboard } from "./dashboard.mjs"

test("dashboard reads only ZGAP OAuth accounts and never exposes credentials", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zgap-dashboard-"))
  await writeFile(path.join(dir, "plugin-auth.json"), JSON.stringify({
    zgap: { type: "oauth", access: "access-one", accountId: "one@example.com" },
    "other#one": { type: "oauth", access: "other", accountId: "other@example.com" },
    "zgap#two": { type: "oauth", access: "access-two", accountId: "two@example.com" },
  }))
  const accounts = await readAccounts(dir)
  assert.deepEqual(accounts.map(({ id, label }) => ({ id, label })), [
    { id: createHash("sha256").update("zgap").digest("hex").slice(0, 20), label: "one@example.com" },
    { id: createHash("sha256").update("zgap#two").digest("hex").slice(0, 20), label: "two@example.com" },
  ])
  assert.equal(JSON.stringify(accounts.map(({ auth, ...publicAccount }) => publicAccount)).includes("access-one"), false)
})

test("dashboard proxies usage with the selected OAuth account and opaque page token", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zgap-dashboard-"))
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
    const usage = await fetch(`http://127.0.0.1:${port}/api/usage?account=${account}&days=7`, { headers: { origin: "null", "x-zgap-page-token": token } })
    assert.equal(usage.status, 200)
    assert.equal(calls[0].headers.authorization, "Bearer access-one")
    assert.equal(calls[0].url, "https://ai-proxy.zz.gg/v1/dashboard?days=7&timeZone=UTC")
    assert.equal(JSON.stringify(await usage.json()).includes("access-one"), false)
  } finally { server.close() }
})
