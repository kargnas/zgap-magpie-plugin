// ZGAP (https://ai-proxy.zz.gg) as a magpie provider. It signs in with ZGAP's device flow,
// leaves renewing the rotating tokens to magpie (auth.refresh), and sends every request with the
// current access token and the request context ZGAP's usage stats read.
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import os from "node:os"

const ID = "zgap"
const ORIGIN = "https://ai-proxy.zz.gg"
const BASE = `${ORIGIN}/v1`
// ZGAP keeps one device session per (user, client, device ID). Its own client ID keeps this
// plugin's sessions apart from the zgap CLI's, so signing in here never logs the CLI out.
const CLIENT_ID = "magpie"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const NPM = "@ai-sdk/openai-compatible"
// ZGAP serves every model on Chat Completions, Messages and Responses alike. Listing all three has
// magpie relay each agent's request in its own protocol instead of translating it to Chat.
const ALSO = ["@ai-sdk/anthropic", "@ai-sdk/openai"]
const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version
const OS_NAMES = { aix: "AIX", android: "Android", darwin: "macOS", freebsd: "FreeBSD", linux: "Linux", openbsd: "OpenBSD", sunos: "SunOS", win32: "Windows" }

// magpie marks an account as needing a new sign-in only for an error whose signIn is "expired".
class SignInExpired extends Error {
  constructor(reason) {
    super(`ZGAP: ${reason}. Sign in again.`)
    this.signIn = "expired"
  }
}

// The zgap CLI's limits. ZGAP refuses an empty value or one with control characters.
function bounded(value, maximum) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim().slice(0, maximum) || "unknown"
}

function systemInfo() {
  return {
    hostname: bounded(os.hostname(), 255),
    os_name: bounded(OS_NAMES[os.platform()] ?? os.platform(), 32),
    os_version: bounded(os.release(), 128),
    os_arch: bounded(os.arch(), 32),
  }
}

// One device ID per computer and home folder: signing in again here updates the same ZGAP session,
// and the name given to it on the ZGAP console, instead of adding a session each time.
function deviceId() {
  return createHash("sha256").update(["zgap-magpie", os.hostname(), os.homedir()].join("\0")).digest("base64url")
}

async function post(path, body, signal) {
  const res = await fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  })
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) }
}

function tokens(body) {
  if (typeof body?.access_token !== "string" || typeof body.refresh_token !== "string" || !(body.expires_in > 0)) {
    throw new Error("ZGAP: the token response is not valid")
  }
  return { access: body.access_token, refresh: body.refresh_token, expires: Date.now() + body.expires_in * 1000 }
}

// The access token is ZGAP's signed JWT. Its email names the account in magpie's account list.
function emailOf(jwt) {
  try {
    const email = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")).email
    return typeof email === "string" && email ? email : undefined
  } catch {
    return undefined
  }
}

// The browser goes to ZGAP's own approval page only, whatever the response says.
function approvalURL(value) {
  try {
    const url = new URL(value)
    return url.origin === ORIGIN && url.pathname === "/console/cli-auth" ? url.href : null
  } catch {
    return null
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

async function poll(grant, verifier, signal) {
  const deadline = Date.now() + grant.expires_in * 1000
  let interval = (grant.interval > 0 ? grant.interval : 5) * 1000
  while (Date.now() < deadline) {
    await sleep(interval, signal)
    const res = await post("/cli/oauth/token", { client_id: CLIENT_ID, grant_type: DEVICE_GRANT, device_code: grant.device_code, code_verifier: verifier }, signal)
    if (res.ok) {
      const saved = tokens(res.body)
      const email = emailOf(saved.access)
      return { type: "success", ...saved, ...(email ? { accountId: email } : {}) }
    }
    const error = res.body?.error
    // A 5xx is ZGAP being redeployed or busy; the approval still stands, so keep polling.
    if (error === "authorization_pending" || res.status >= 500) continue
    if (error === "slow_down") {
      interval += 5000
      continue
    }
    return { type: "failed", error: `ZGAP: sign-in failed (${error ?? `HTTP ${res.status}`})` }
  }
  return { type: "failed", error: "ZGAP: the sign-in code expired. Start the sign-in again." }
}

async function authorize(_inputs, { signal } = {}) {
  const verifier = randomBytes(32).toString("base64url")
  const res = await post("/cli/oauth/device_authorization", {
    client_id: CLIENT_ID,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    device_id: deviceId(),
    system_info: systemInfo(),
  }, signal)
  const grant = res.body
  if (!res.ok) throw new Error(`ZGAP: sign-in could not start (${grant?.error ?? `HTTP ${res.status}`})`)
  const url = approvalURL(grant?.verification_uri_complete)
  if (!url || typeof grant.device_code !== "string" || typeof grant.user_code !== "string" || !(grant.expires_in > 0)) {
    throw new Error("ZGAP: the sign-in response is not valid")
  }
  let pending
  return {
    url,
    method: "auto",
    instructions: `Approve the sign-in in your browser with the Google account you use for ZGAP. Code: ${grant.user_code}`,
    callback(_code, { signal: wait } = {}) {
      pending ??= poll(grant, verifier, wait).catch((error) => ({ type: "failed", error: error?.message ?? String(error) }))
      return pending
    },
  }
}

async function refresh(auth) {
  if (auth?.type !== "oauth" || typeof auth.refresh !== "string") return undefined
  const res = await post("/cli/oauth/token", { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: auth.refresh })
  if (res.ok) return tokens(res.body)
  // invalid_grant: the refresh token was already spent, the device was logged out on the ZGAP
  // console, or the account was disabled. Any other answer keeps the sign-in for a later retry.
  if (res.body?.error === "invalid_grant") throw new SignInExpired("the sign-in was revoked or replaced")
  throw new Error(`ZGAP: token refresh failed (${res.body?.error ?? `HTTP ${res.status}`})`)
}

// The diagnostic context the zgap CLI sends as X-Zgap-Request-Context. ZGAP keeps it with each
// request's usage and removes it before the model provider. No prompt or command line goes in it.
function requestContext(headers) {
  const context = { v: 1, tool: "magpie", wrapper_version: VERSION, ...systemInfo() }
  let cwd = ""
  try {
    cwd = decodeURIComponent(headers.get("x-magpie-work-dir") ?? "")
  } catch {}
  if (cwd) {
    context.cwd = cwd
    const project = cwd.split(/[\\/]/).filter(Boolean).at(-1)
    if (project) context.project = project
  }
  const session = headers.get("x-magpie-session")
  if (session) context.session_id = session
  return Buffer.from(JSON.stringify(context), "utf8").toString("base64url")
}

async function send(getAuth, input, init) {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== ORIGIN || !url.pathname.startsWith("/v1/")) {
    throw new Error(`ZGAP: refusing to send the sign-in to ${url.origin}${url.pathname}`)
  }
  const auth = await getAuth()
  if (auth?.type !== "oauth" || typeof auth.access !== "string") throw new SignInExpired("not signed in")
  const headers = new Headers(request.headers)
  headers.set("x-zgap-request-context", requestContext(headers))
  // ZGAP's statistics and account routing read the session from x-session-id. magpie's own
  // headers are for the plugin alone.
  const session = headers.get("x-magpie-session")
  if (session) headers.set("x-session-id", session)
  for (const name of [...headers.keys()]) if (name.startsWith("x-magpie-")) headers.delete(name)
  // ZGAP refuses a request whose x-api-key and Bearer differ, so the Bearer is the only credential sent.
  headers.delete("x-api-key")
  headers.set("authorization", `Bearer ${auth.access}`)
  const res = await fetch(url, {
    method: request.method,
    headers,
    body: request.body ? await request.arrayBuffer() : undefined,
    signal: request.signal,
    redirect: "error",
  })
  // fetch has decoded the body, so the upstream encoding and length no longer describe it.
  const out = new Headers(res.headers)
  out.delete("content-encoding")
  out.delete("content-length")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}

async function models(provider, { auth }) {
  if (auth?.type !== "oauth") return provider.models
  const res = await fetch(`${BASE}/models`, {
    headers: { accept: "application/json", authorization: `Bearer ${auth.access}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`ZGAP: the model list failed (HTTP ${res.status})`)
  const body = await res.json().catch(() => null)
  if (!Array.isArray(body?.data)) throw new Error("ZGAP: the model list is not valid")
  return Object.fromEntries(body.data.filter((m) => typeof m?.id === "string" && m.id).map((m) => [m.id, {
    id: m.id,
    providerID: ID,
    name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.id,
    api: { id: m.id, url: BASE, npm: NPM },
    also: ALSO,
    status: "active",
    limit: { context: Number.isFinite(m.context_length) && m.context_length > 0 ? m.context_length : 0, output: 0 },
  }]))
}

export async function ZgapPlugin() {
  return {
    config: async (config) => {
      config.provider ??= {}
      const p = (config.provider[ID] ??= {})
      p.name ??= "ZGAP"
      p.npm ??= NPM
      p.api ??= BASE
    },
    provider: { id: ID, models },
    auth: {
      provider: ID,
      // ZGAP rotates the refresh token on every renewal and refuses the old one.
      rotating: true,
      methods: [{ type: "oauth", label: "ZGAP (browser sign-in)", authorize }],
      refresh,
      loader: async (getAuth) => ({ baseURL: BASE, fetch: (input, init) => send(getAuth, input, init) }),
    },
  }
}
