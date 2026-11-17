import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
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
    limit: { context: 272000, output: 0 },
  })
  assert.equal(listed["moonshot/kimi-test"].name, "moonshot/kimi-test")
  assert.equal(listed["moonshot/kimi-test"].limit.context, 0)

  stub(() => json(503, {}))
  await assert.rejects(() => provider.models({ id: "zgap", models: {} }, { auth: { type: "oauth", access: "token" } }), /HTTP 503/)
})
