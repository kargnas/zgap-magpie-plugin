import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { afterEach, test } from "node:test"
import { ZgapPlugin } from "./index.mjs"

const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const jwt = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

// Replaces fetch and records each request as ZGAP would read it.
function stub(answer) {
  const calls = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const text = await request.text()
    const call = { url: request.url, method: request.method, headers: request.headers, body: text ? JSON.parse(text) : undefined }
    calls.push(call)
    return answer(call, calls.length)
  }
  return calls
}

const grant = {
  device_code: "device-code",
  user_code: "ABCD2345",
  verification_uri: "https://ai-proxy.zz.gg/console/cli-auth",
  verification_uri_complete: "https://ai-proxy.zz.gg/console/cli-auth?device_code=device-code&user_code=ABCD2345",
  expires_in: 300,
  interval: 0.01,
}

test("sign-in uses client magpie, S256 PKCE and a stable device ID, and names the account by its email", async () => {
  const { auth } = await ZgapPlugin()
  const access = jwt({ email: "friend@example.com" })
  const calls = stub(({ url }, n) => {
    if (url === "https://ai-proxy.zz.gg/cli/oauth/device_authorization") return json(200, grant)
    return n === 2 ? json(400, { error: "authorization_pending" }) : json(200, { access_token: access, refresh_token: "zgap-rt-1", expires_in: 86400, token_type: "Bearer" })
  })
  const started = Date.now()
  const flow = await auth.methods[0].authorize({}, {})
  assert.equal(flow.url, grant.verification_uri_complete)
  assert.equal(flow.method, "auto")
  assert.match(flow.instructions, /ABCD2345/)
  const result = await flow.callback(undefined, {})

  const [start, pending, done] = calls
  assert.equal(start.body.client_id, "magpie")
  assert.equal(start.body.code_challenge_method, "S256")
  assert.match(start.body.device_id, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(Object.keys(start.body.system_info).sort(), ["hostname", "os_arch", "os_name", "os_version"])
  for (const call of [pending, done]) {
    assert.equal(call.url, "https://ai-proxy.zz.gg/cli/oauth/token")
    assert.equal(call.body.client_id, "magpie")
    assert.equal(call.body.grant_type, "urn:ietf:params:oauth:grant-type:device_code")
    assert.equal(createHash("sha256").update(call.body.code_verifier).digest("base64url"), start.body.code_challenge)
  }
  assert.equal(result.type, "success")
  assert.equal(result.access, access)
  assert.equal(result.refresh, "zgap-rt-1")
  assert.equal(result.accountId, "friend@example.com")
  assert.ok(result.expires >= started + 86400_000 && result.expires <= Date.now() + 86400_000)

  await auth.methods[0].authorize({}, {})
  assert.equal(calls.at(-1).body.device_id, start.body.device_id, "signing in again on this computer reuses its ZGAP session")
})

test("sign-in refuses an approval link that isn't ZGAP's own page", async () => {
  const { auth } = await ZgapPlugin()
  stub(() => json(200, { ...grant, verification_uri_complete: "https://evil.example/console/cli-auth?device_code=x" }))
  await assert.rejects(() => auth.methods[0].authorize({}, {}), /not valid/)
})

test("sign-in reports ZGAP's refusal instead of polling until the code expires", async () => {
  const { auth } = await ZgapPlugin()
  stub(({ url }) => url.endsWith("/device_authorization") ? json(200, grant) : json(400, { error: "invalid_grant" }))
  const flow = await auth.methods[0].authorize({}, {})
  assert.deepEqual(await flow.callback(undefined, {}), { type: "failed", error: "ZGAP: sign-in failed (invalid_grant)" })
})

test("refresh rotates both tokens, and only invalid_grant asks for a new sign-in", async () => {
  const { auth } = await ZgapPlugin()
  const saved = { type: "oauth", access: "old", refresh: "zgap-rt-old", expires: 1 }
  const calls = stub(() => json(200, { access_token: "new", refresh_token: "zgap-rt-new", expires_in: 86400 }))
  const renewed = await auth.refresh(saved)
  assert.deepEqual(calls[0].body, { client_id: "magpie", grant_type: "refresh_token", refresh_token: "zgap-rt-old" })
  assert.equal(renewed.access, "new")
  assert.equal(renewed.refresh, "zgap-rt-new")

  stub(() => json(400, { error: "invalid_grant" }))
  await assert.rejects(() => auth.refresh(saved), (error) => error.signIn === "expired")
  stub(() => json(502, {}))
  await assert.rejects(() => auth.refresh(saved), (error) => error.signIn === undefined && /HTTP 502/.test(error.message))
})

test("requests carry the current token, the session and the request context, and never magpie's own headers", async () => {
  const { auth } = await ZgapPlugin()
  let access = "first"
  const { baseURL, fetch: send } = await auth.loader(async () => ({ type: "oauth", access, refresh: "zgap-rt", expires: Date.now() + 60_000 }))
  assert.equal(baseURL, "https://ai-proxy.zz.gg/v1")
  const calls = stub(() => new Response("ok", { headers: { "content-encoding": "gzip", "content-length": "2", "x-request-id": "r1" } }))
  const ask = () => send("https://ai-proxy.zz.gg/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "x-api-key": "placeholder",
      "x-magpie-session": "session-1",
      "x-magpie-work-dir": encodeURIComponent("/work/프로젝트"),
      "x-magpie-fallback": "1",
    },
    body: JSON.stringify({ model: "anthropic/claude-test" }),
  })

  const res = await ask()
  assert.equal(await res.text(), "ok")
  assert.equal(res.headers.get("content-encoding"), null)
  assert.equal(res.headers.get("x-request-id"), "r1")
  const [sent] = calls
  assert.equal(sent.url, "https://ai-proxy.zz.gg/v1/messages")
  assert.deepEqual(sent.body, { model: "anthropic/claude-test" })
  assert.equal(sent.headers.get("authorization"), "Bearer first")
  assert.equal(sent.headers.get("x-api-key"), null)
  assert.equal(sent.headers.get("anthropic-version"), "2023-06-01")
  assert.equal(sent.headers.get("x-session-id"), "session-1")
  assert.deepEqual([...sent.headers.keys()].filter((name) => name.startsWith("x-magpie-")), [])
  const context = JSON.parse(Buffer.from(sent.headers.get("x-zgap-request-context"), "base64url").toString("utf8"))
  assert.equal(context.v, 1)
  assert.equal(context.tool, "magpie")
  assert.equal(context.wrapper_version, VERSION)
  assert.equal(context.cwd, "/work/프로젝트")
  assert.equal(context.project, "프로젝트")
  assert.equal(context.session_id, "session-1")
  assert.ok(context.hostname && context.os_name && context.os_version && context.os_arch)

  // magpie renews the sign-in in its store; the next request reads it there, not a copy taken earlier.
  access = "second"
  await ask()
  assert.equal(calls[1].headers.get("authorization"), "Bearer second")
})

test("the token goes to ZGAP's API only", async () => {
  const { auth } = await ZgapPlugin()
  const { fetch: send } = await auth.loader(async () => ({ type: "oauth", access: "token" }))
  const calls = stub(() => new Response("ok"))
  for (const url of ["https://evil.example/v1/messages", "https://ai-proxy.zz.gg/console/api/me"]) {
    await assert.rejects(() => send(url, { method: "POST", body: "{}" }), /refusing/)
  }
  assert.equal(calls.length, 0)
})

test("models come from ZGAP's list and are served on all three APIs", async () => {
  const { provider } = await ZgapPlugin()
  const calls = stub(() => json(200, { object: "list", data: [
    { id: "openai/gpt-test", owned_by: "openai", display_name: "GPT Test", context_length: 272000 },
    { id: "moonshot/kimi-test", owned_by: "moonshot" },
    { owned_by: "broken" },
  ] }))
  const listed = await provider.models({ id: "zgap", models: {} }, { auth: { type: "oauth", access: "token" } })
  assert.equal(calls[0].url, "https://ai-proxy.zz.gg/v1/models")
  assert.equal(calls[0].headers.get("authorization"), "Bearer token")
  assert.deepEqual(Object.keys(listed), ["openai/gpt-test", "moonshot/kimi-test"])
  assert.deepEqual(listed["openai/gpt-test"], {
    id: "openai/gpt-test",
    providerID: "zgap",
    name: "GPT Test",
    api: { id: "openai/gpt-test", url: "https://ai-proxy.zz.gg/v1", npm: "@ai-sdk/openai-compatible" },
    also: ["@ai-sdk/anthropic", "@ai-sdk/openai"],
    status: "active",
    limit: { context: 272000 },
    capabilities: {},
  })
  assert.equal(listed["moonshot/kimi-test"].name, "moonshot/kimi-test")
  assert.equal(listed["moonshot/kimi-test"].limit.context, undefined)

  stub(() => json(503, {}))
  await assert.rejects(() => provider.models({ id: "zgap", models: {} }, { auth: { type: "oauth", access: "token" } }), /HTTP 503/)
})

test("catalog metadata keeps routing IDs, explicit false values and unknown limits", async () => {
  const { provider } = await ZgapPlugin()
  stub(() => json(200, { data: [
    { id: "invented.publisher/model-9-3", display_name: "Model Nine 9.3", context_length: 400000, max_output_tokens: 32000,
      input_modalities: ["text"], output_modalities: ["text", "audio"], reasoning: false, tool_call: true, temperature: false },
    { id: "new.publisher/vision", max_output_tokens: -1, input_modalities: ["text", "image"], reasoning: true },
    { id: "unknown/item", context_length: "1000", max_output_tokens: null, input_modalities: [null] },
  ] }))
  const rows = await provider.models({ models: {} }, { auth: { type: "oauth", access: "token" } })
  const first = rows["invented.publisher/model-9-3"]
  assert.equal(first.name, "Model Nine 9.3")
  assert.equal(first.api.id, "invented.publisher/model-9-3")
  assert.deepEqual(first.limit, { context: 400000, output: 32000 })
  assert.deepEqual(first.capabilities, { reasoning: false, toolcall: true, input: { text: true, image: false }, output: { text: true, audio: true, image: false } })
  assert.equal(first.temperature, false)
  assert.equal(rows["new.publisher/vision"].capabilities.input.image, true)
  assert.equal(rows["new.publisher/vision"].capabilities.reasoning, true)
  assert.deepEqual(rows["unknown/item"].limit, {})
  assert.deepEqual(rows["unknown/item"].capabilities, {})
})

test("speed tiers in ZGAP's list reach magpie as serviceTiers, and a model without them gets none", async () => {
  const { provider } = await ZgapPlugin()
  const tiers = [{ id: "priority", name: "Fast" }, { id: "ultrafast", name: "Ultrafast" }]
  stub(() => json(200, { data: [
    { id: "openai/gpt-imaginary-9", service_tiers: tiers },
    { id: "openai/gpt-no-tiers" },
    { id: "odd/model", service_tiers: "priority" },
  ] }))
  const rows = await provider.models({ models: {} }, { auth: { type: "oauth", access: "token" } })
  assert.deepEqual(rows["openai/gpt-imaginary-9"].serviceTiers, tiers)
  assert.equal("serviceTiers" in rows["openai/gpt-no-tiers"], false)
  assert.equal("serviceTiers" in rows["odd/model"], false)
})

test("reasoning effort levels in ZGAP's list reach magpie as variants, and a model without them gets none", async () => {
  const { provider } = await ZgapPlugin()
  stub(() => json(200, { data: [
    { id: "relay/thinker", reasoning: true, reasoning_efforts: ["low", "high", "max"] },
    { id: "relay/plain", reasoning: true },
    { id: "relay/odd", reasoning: true, reasoning_efforts: "high" },
    { id: "relay/junk", reasoning: true, reasoning_efforts: [1, "", "low"] },
  ] }))
  const rows = await provider.models({ models: {} }, { auth: { type: "oauth", access: "token" } })
  assert.deepEqual(Object.keys(rows["relay/thinker"].variants), ["low", "high", "max"])
  assert.equal(rows["relay/thinker"].capabilities.reasoning, true)
  assert.equal("variants" in rows["relay/plain"], false)
  assert.equal("variants" in rows["relay/odd"], false)
  assert.deepEqual(Object.keys(rows["relay/junk"].variants), ["low"])
})

// The shape ZGAP's /v1/dashboard/remaining-usage answers (agp-proxy-stack remainingUsageView).
const win = (id, label, usedPercent, durationSeconds, accountWide, recharges = []) => ({ id, label, usedPercent, durationSeconds, accountWide, recharges })
const remaining = {
  generatedAt: "2026-11-26T03:00:00Z",
  providers: [
    { provider: "claude", windows: [
      win("five_hour", "Session", 18.2, 18000, true, [{ at: "2026-11-26T04:00:00Z", percent: 4 }]),
      win("seven_day", "Weekly", null, 604800, true),
      win("limit-fable", "Fable", 95, null, false),
      win("seven_day_oauth_apps", "OAuth apps", 40, null, false),
    ] },
    { provider: "codex", windows: [
      win("weekly", "Weekly", 62, 604800, true),
      win("gpt-5-3-codex-spark-weekly", "GPT-5.3-Codex-Spark · Weekly", 100, 604800, false),
      win("code-review-weekly", "Code review · Weekly", 99, 604800, false),
    ] },
    // Kimi's short limit: ZGAP keeps Kimi's own words in its ID and names it by its length.
    { provider: "kimi", windows: [win("300time-unit-minute", "5h", 12, 18000, true), win("weekly", "Weekly", 7, 604800, true)] },
    { provider: "xai", windows: [win("credits", "Credits (Weekly)", 3, 604800, true), win("on-demand", "On-demand", 20, null, false)] },
    { provider: "antigravity", windows: [win("gemini-3-pro-high", "Gemini 3 Pro · gemini-3-pro-high", 50, null, false)] },
  ],
}
const zgapModels = Object.fromEntries(["anthropic/claude-fable-5-2", "anthropic/claude-sonnet-5-5", "openai/gpt-6.2-sol", "openai/gpt-5.3-codex-spark", "moonshot/kimi-k3", "x-ai/grok-5", "laysoai/glm-5"].map((id) => [id, { id }]))

test("usage reads ZGAP's remaining usage into windows that count only the models of their upstream", async () => {
  const { auth } = await ZgapPlugin()
  const calls = stub(() => json(200, remaining))
  const read = await auth.usage(async () => ({ type: "oauth", access: "token" }), { id: "zgap", models: zgapModels }, {})
  assert.equal(calls[0].url, "https://ai-proxy.zz.gg/v1/dashboard/remaining-usage")
  assert.equal(calls[0].headers.get("authorization"), "Bearer token")
  const claude = ["anthropic/claude-fable-5-2", "anthropic/claude-sonnet-5-5"]
  assert.deepEqual(read, { windows: [
    { name: "claude · Session", used: 18.2, span: 18000, models: claude },
    // Weekly was measured on no account: left out, not 0% used.
    { name: "claude · Fable", used: 95, models: ["anthropic/claude-fable-5-2"] },
    { name: "claude · OAuth apps", used: 40, aside: true },
    { name: "codex · Weekly", used: 62, span: 604800, models: ["openai/gpt-6.2-sol", "openai/gpt-5.3-codex-spark"] },
    { name: "codex · GPT-5.3-Codex-Spark · Weekly", used: 100, span: 604800, models: ["openai/gpt-5.3-codex-spark"] },
    { name: "codex · Code review · Weekly", used: 99, span: 604800, aside: true },
    // Account-wide windows count every model of their upstream, whatever they are called.
    { name: "kimi · 5h", used: 12, span: 18000, models: ["moonshot/kimi-k3"] },
    { name: "kimi · Weekly", used: 7, span: 604800, models: ["moonshot/kimi-k3"] },
    { name: "xai · Credits (Weekly)", used: 3, span: 604800, models: ["x-ai/grok-5"] },
    { name: "xai · On-demand", used: 20, aside: true },
    // No listed model is served by it, so it holds back none of them.
    { name: "antigravity · Gemini 3 Pro · gemini-3-pro-high", used: 50, aside: true },
  ] })
  assert.ok(read.windows.every((w) => !("resetsAt" in w)), "ZGAP's recharges each bring back a part of a window, not a reset")

  // Before the model list is read, nothing is scoped to all models.
  const unlisted = await auth.usage(async () => ({ type: "oauth", access: "token" }), { id: "zgap", models: {} })
  assert.ok(unlisted.windows.every((w) => w.aside && !("models" in w)))
})

test("a failed usage read is an error, never 0% used, and leaves the sign-in alone unless there is none", async () => {
  const { auth } = await ZgapPlugin()
  const signedIn = async () => ({ type: "oauth", access: "token" })
  for (const [status, body, message] of [
    [503, { error: "quota_unavailable" }, /remaining usage failed \(quota_unavailable\)/],
    [403, { error: "not_registered" }, /not_registered/],
    [401, { error: "invalid_token" }, /invalid_token/],
    [502, "<html>", /HTTP 502/],
    [200, { providers: "none" }, /not valid/],
  ]) {
    stub(() => (typeof body === "string" ? new Response(body, { status }) : json(status, body)))
    // magpie marks the account for a new sign-in on an error saying "sign in again", or on signIn: "expired".
    await assert.rejects(() => auth.usage(signedIn, { models: zgapModels }), (error) => message.test(error.message) && !/sign in again/i.test(error.message) && error.signIn === undefined)
  }
  const calls = stub(() => json(200, remaining))
  await assert.rejects(() => auth.usage(async () => undefined, { models: zgapModels }), (error) => error.signIn === "expired")
  assert.equal(calls.length, 0, "no request goes out without a token")

  const stop = new AbortController()
  stop.abort(new Error("magpie gave up"))
  globalThis.fetch = async (_input, init) => init.signal.throwIfAborted()
  await assert.rejects(() => auth.usage(signedIn, { models: zgapModels }, { signal: stop.signal }), /magpie gave up/)
})

test("a good usage read stands 3 minutes for its own sign-in only, and a failed one is tried again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 })
  const { auth } = await ZgapPlugin()
  const as = (access) => async () => ({ type: "oauth", access })
  let status = 503
  const calls = stub(() => (status === 200 ? json(200, remaining) : json(status, { error: "quota_unavailable" })))
  await assert.rejects(() => auth.usage(as("a"), { models: zgapModels }), /quota_unavailable/)
  status = 200
  // A fresh good read says nothing of the sign-in, so magpie takes it as clean and clears an expired mark.
  assert.equal((await auth.usage(as("a"), { models: zgapModels })).signIn, undefined)
  assert.equal(calls.length, 2, "a failed read is not kept")

  t.mock.timers.tick(3 * 60_000 - 1)
  const kept = await auth.usage(as("a"), { models: {} })
  assert.equal(calls.length, 2)
  // A kept read leaves the sign-in as magpie has it: the token may have lapsed since it was read.
  assert.equal(kept.signIn, "kept")
  assert.ok(kept.windows.length && kept.windows.every((w) => w.aside), "a kept read counts the models listed now")
  await auth.usage(as("b"), { models: zgapModels })
  assert.equal(calls.length, 3, "another sign-in reads its own")

  t.mock.timers.tick(1)
  assert.equal((await auth.usage(as("a"), { models: zgapModels })).signIn, undefined)
  assert.equal(calls.length, 4, "after 3 minutes ZGAP is read again")
})

// magpie keeps the plugin host it replaces (a Bun update, a plugin installed, updated or set) until
// that host's replies end, so the new host loads ZGAP while the old one still holds the page's port.
test("ZGAP loads while another host holds the page's port, and the page takes the port once it is free", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zgap-page-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const oldHost = http.createServer()
  await new Promise((resolve) => oldHost.listen(0, "127.0.0.1", resolve))
  oldHost.unref()
  const { port } = oldHost.address()
  const waiting = new Promise((resolve) => t.mock.method(console, "error", (line) => {
    if (String(line).includes(`port ${port} is in use`)) resolve()
  }))

  const { auth, provider } = await ZgapPlugin({ magpie: {}, directory }, { port })
  assert.equal(auth.provider, "zgap")
  assert.equal(provider.id, "zgap")

  // The old host lets go only after the page has found the port taken.
  await waiting
  await new Promise((resolve) => oldHost.close(resolve))
  let page
  for (const deadline = Date.now() + 5000; Date.now() < deadline && !page?.ok; await new Promise((resolve) => setTimeout(resolve, 100))) {
    page = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined)
  }
  assert.equal(page?.status, 200)
  assert.match(await page.text(), /name="zgap-page-token"/)
})
