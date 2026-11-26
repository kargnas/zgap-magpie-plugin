// ZGAP (https://ai-proxy.zz.gg) as a magpie provider. It signs in with ZGAP's device flow,
// leaves renewing the rotating tokens to magpie (auth.refresh), and sends every request with the
// current access token and the request context ZGAP's usage stats read.
import { createHash, randomBytes } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import os from "node:os"
import { startDashboard } from "./dashboard.mjs"

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
const MANIFEST = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
const VERSION = MANIFEST.version
let dashboard
const SIGN_IN_LABELS = Object.fromEntries(readdirSync(new URL("./locales/", import.meta.url))
  .filter((file) => file.endsWith(".json"))
  .map((file) => [file.slice(0, -5), JSON.parse(readFileSync(new URL(`./locales/${file}`, import.meta.url), "utf8")).signInLabel]))
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
    limit: {
      ...(Number.isInteger(m.context_length) && m.context_length > 0 ? { context: m.context_length } : {}),
      ...(Number.isInteger(m.max_output_tokens) && m.max_output_tokens > 0 ? { output: m.max_output_tokens } : {}),
    },
    capabilities: {
      ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
      ...(typeof m.tool_call === "boolean" ? { toolcall: m.tool_call } : {}),
      ...Object.fromEntries(["input", "output"].flatMap((direction) => {
        const values = m[`${direction}_modalities`]
        if (!Array.isArray(values) || !values.every((value) => typeof value === "string" && value)) return []
        // Explicit image=false keeps an administrator's text-only policy visible to magpie.
        return [[direction, { ...Object.fromEntries(values.map((value) => [value, true])), image: values.includes("image") }]]
      })),
    },
    ...(typeof m.temperature === "boolean" ? { temperature: m.temperature } : {}),
    // magpie offers Fast and Ultrafast only on a model whose serviceTiers name them. ZGAP lists the
    // tiers its accounts serve the model at, as Codex gets them; magpie reads each object's id.
    ...(Array.isArray(m.service_tiers) ? { serviceTiers: m.service_tiers } : {}),
    ...variantsOf(m.reasoning_efforts),
  }]))
}

// magpie reads a reasoning model's effort levels from the names of its OpenCode variants; without
// them it guesses the levels from its own models.dev copy by model name, which knows no reseller's
// model. ZGAP lists the levels the model's upstream says it takes. magpie never reads a variant's
// value, so each is empty.
function variantsOf(efforts) {
  if (!Array.isArray(efforts)) return {}
  const levels = efforts.filter((level) => typeof level === "string" && level)
  return levels.length ? { variants: Object.fromEntries(levels.map((level) => [level, {}])) } : {}
}

// The upstream ZGAP's quota windows are reported under (claude, codex, kimi, xai, ...) for the
// owner each listed model ID starts with. anthropic, openai and x-ai are aliases ZGAP's quota plugin
// folds into these names (cliproxy-quota normalizedProvider); moonshot is the owner ZGAP lists native
// Kimi models under. Any other owner is its own name (zai, or an OpenAI-compatible provider, which
// has no quota window).
const UPSTREAMS = { anthropic: "claude", openai: "codex", moonshot: "kimi", "x-ai": "xai" }
// The windows ZGAP reports for an upstream's whole account, by ID, and how many seconds each runs.
// magpie ranks a week ahead of the five hours in it and treats the five hours as a rate cap.
const SPANS = { five_hour: 5 * 3600, session: 5 * 3600, seven_day: 7 * 86400, weekly: 7 * 86400 }
// How long a good remaining-usage read stands. A running magpie (the app, `magpie serve`) reads every
// account's usage each minute, and these means over ZGAP's accounts move slowly, so 3 minutes is
// enough. Each magpie command starts its own plugin host, so a `magpie quota` run always reads afresh.
const USAGE_KEPT_MS = 3 * 60_000

// magpie's auth.usage hook: `magpie quota`, the Usage page and Quota first routing read it.
// ZGAP's remaining usage is the gateway's, not this account's own: per upstream, each window's
// usedPercent is the mean share used over the upstream's accounts (null when none was measured).
// ZGAP leaves out reset times on purpose: accounts renew at their own times, and its recharges
// bring back a few percent each, so no time renews the whole window. Without resetsAt, magpie takes
// a window to renew a full span from now, so Quota first spends accounts renewing sooner first. A
// 5-hour window at 90% used, or any window at 98%, still puts ZGAP behind the others.
// kept holds this plugin's good reads by access token: ZGAP answers each sign-in on its own (403
// for one it no longer serves), so one account's read never stands for another's, and a renewed
// token reads afresh. A failed read is not kept, so magpie's next read tries ZGAP again.
async function usage(kept, getAuth, provider, { signal } = {}) {
  const auth = await getAuth()
  if (auth?.type !== "oauth" || typeof auth.access !== "string") throw new SignInExpired("not signed in")
  const ids = Object.keys(provider?.models ?? {})
  const now = Date.now()
  for (const [token, read] of kept) if (now - read.at >= USAGE_KEPT_MS) kept.delete(token)
  const read = kept.get(auth.access)
  // A kept read says nothing new about the sign-in ("kept"): without it magpie would take the read as
  // a clean one and clear the account's expired mark, though the token may have lapsed since.
  if (read) return { windows: read.providers.flatMap((entry) => windowsOf(entry, ids)), signIn: "kept" }
  const res = await fetch(`${BASE}/dashboard/remaining-usage`, {
    headers: { accept: "application/json", authorization: `Bearer ${auth.access}` },
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  })
  const body = await res.json().catch(() => null)
  // A failed read stays an error, not 0% used: magpie then keeps the account's usage unknown.
  // A 401 here leaves the sign-in to the next model request, which renews or expires it as before.
  if (!res.ok) throw new Error(`ZGAP: remaining usage failed (${body?.error ?? `HTTP ${res.status}`})`)
  if (!Array.isArray(body?.providers)) throw new Error("ZGAP: the remaining usage is not valid")
  kept.set(auth.access, { at: Date.now(), providers: body.providers })
  return { windows: body.providers.flatMap((entry) => windowsOf(entry, ids)) }
}

function windowsOf(entry, ids) {
  const upstream = String(entry?.provider ?? "")
  const served = ids.filter((id) => {
    const owner = id.includes("/") ? id.slice(0, id.indexOf("/")).toLowerCase() : ""
    return owner !== "" && (UPSTREAMS[owner] ?? owner) === upstream
  })
  // A window no account measured has no share: it is left out, never sent as 0% used.
  return (Array.isArray(entry?.windows) ? entry.windows : []).filter((w) => Number.isFinite(w?.usedPercent)).map((w) => {
    const label = typeof w.label === "string" && w.label ? w.label : String(w.id ?? "")
    const span = SPANS[w.id]
    // Other windows count only the models they are named after (Claude's "Fable", a Codex model's
    // own "GPT-5.3-Codex-Spark · Weekly"). One that names none (Codex's code review, Claude's
    // OAuth apps) is shown but set aside, so it never holds back the upstream's other models.
    const named = label.split(" · ")[0].toLowerCase()
    const models = span ? served : served.filter((id) => named && id.toLowerCase().includes(named))
    return { name: `${upstream} · ${label}`, used: w.usedPercent, ...(span ? { span } : {}), ...(models.length ? { models } : { aside: true }) }
  })
}

export async function ZgapPlugin(input, options = {}) {
  // The page is an extra and never decides whether ZGAP loads. Without this plugin loaded, magpie sends
  // ZGAP requests with no token: each is a 401, and magpie then shows the account as signed out.
  if (input?.magpie && input.directory) {
    dashboard ??= startDashboard({ directory: input.directory, port: options.port ?? MANIFEST.magpie.page.service.port })
      .catch((error) => console.error(`ZGAP page: ${error.message}`))
  }
  const usageReads = new Map()
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
      methods: [{ type: "oauth", label: SIGN_IN_LABELS.en, labels: SIGN_IN_LABELS, authorize }],
      refresh,
      usage: (...args) => usage(usageReads, ...args),
      loader: async (getAuth) => ({ baseURL: BASE, fetch: (input, init) => send(getAuth, input, init) }),
    },
  }
}
