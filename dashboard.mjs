import http from "node:http"
import { readFile } from "node:fs/promises"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

const ORIGIN = "https://ai-proxy.zz.gg"
const ASSETS = new Map([
  ["/dashboard-boot.js", "text/javascript"], ["/dashboard-bridge.js", "text/javascript"],
  ["/messages.js", "text/javascript"],
  ["/icon.svg", "image/svg+xml"],
])

const CONSOLE_ASSETS = new Map([["/console.js", "text/javascript"], ["/console.css", "text/css"]])
const READS = new Set(["/api/usage-stats", "/api/account-equivalents", "/api/remaining-usage", "/api/events"])

// The host supplies its actual config directory, including portable and isolated installations.
// Read only ZGAP entries; magpie alone writes, renews and removes these credentials.
export async function readAccounts(directory) {
  try {
    const settings = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8"))
    if (settings.noAccountDiscovery === true) return []
  } catch (error) { if (error.code !== "ENOENT") throw error }
  let text
  try { text = await readFile(path.join(directory, "plugin-auth.json"), "utf8") }
  catch (error) { if (error.code === "ENOENT") return []; throw error }
  const saved = JSON.parse(text)
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid magpie sign-in store")
  return Object.entries(saved).filter(([key, value]) => (key === "zgap" || key.startsWith("zgap#")) && value?.type === "oauth" && typeof value.access === "string" && value.access)
    .sort(([a], [b]) => a === "zgap" ? -1 : b === "zgap" ? 1 : a.localeCompare(b))
    .map(([key, auth]) => ({ id: createHash("sha256").update(`${key}\0${auth.accountId ?? ""}`).digest("hex").slice(0, 20), label: typeof auth.accountId === "string" ? auth.accountId : "ZGAP", auth }))
}

export async function startDashboard({ directory, port, fetchImpl = fetch }) {
  if (!path.isAbsolute(directory) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid dashboard configuration")
  const token = randomBytes(32).toString("hex")
  const server = http.createServer(async (request, response) => {
    const address = `127.0.0.1:${server.address().port}`
    const origin = request.headers.origin
    const localOrigin = `http://${address}`
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" }
    const send = (status, body) => {
      response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" })
      response.end(JSON.stringify(body))
    }
    try {
      if (request.headers.host !== address || (origin && origin !== "null" && origin !== localOrigin)) return send(403, { error: "forbidden" })
      const url = new URL(request.url, localOrigin)
      if (url.pathname.startsWith("/api/")) {
        // A sandboxed page has an opaque origin. A random per-process token prevents other
        // opaque-origin pages from using this allowance to read the user's account activity.
        if (origin === "null") Object.assign(headers, { "access-control-allow-origin": "null", vary: "Origin" })
        if (request.method === "OPTIONS") {
          response.writeHead(204, { ...headers, "access-control-allow-methods": "GET", "access-control-allow-headers": "x-zgap-page-token" })
          response.end()
          return
        }
        const supplied = Buffer.from(String(request.headers["x-zgap-page-token"] ?? ""))
        const expected = Buffer.from(token)
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { error: "forbidden" })
        if (request.method !== "GET") return send(405, { error: "method_not_allowed" })
        const accounts = await readAccounts(directory)
        const publicAccounts = accounts.map(({ id, label, auth }) => ({ id, label, revision: createHash("sha256").update(token).update(auth.access).digest("hex").slice(0, 16) }))
        if (url.pathname === "/api/session") return send(200, { accounts: publicAccounts })
        if (!READS.has(url.pathname)) return send(404, { error: "not_found" })
        const account = accounts.find(row => row.id === url.searchParams.get("account"))
        if (!account) return send(401, { error: "not_signed_in" })
        const upstream = new URL(url.pathname.replace("/api/", "/v1/dashboard/"), ORIGIN)
        upstream.search = url.search
        upstream.searchParams.delete("account")
        const stream = url.pathname === "/api/events"
        const controller = new AbortController()
        response.on("close", () => controller.abort())
        const timer = setTimeout(() => controller.abort(), 15000)
        let revocation
        const stillSignedIn = async () => (await readAccounts(directory)).some(row => row.id === account.id && row.auth.access === account.auth.access)
        try {
          const result = await fetchImpl(upstream, {
            headers: { accept: stream ? "text/event-stream" : "application/json", authorization: `Bearer ${account.auth.access}` },
            redirect: "error", signal: controller.signal,
          })
          if (stream && result.ok) {
            if (!result.body || result.headers.get("content-type")?.split(";")[0] !== "text/event-stream") throw new Error("Invalid live response")
            if (!await stillSignedIn()) return send(401, { error: "session_changed" })
            clearTimeout(timer)
            // An open SSE stream outlives the request that selected the account; stop on sign-out or token rotation.
            revocation = setInterval(() => { void stillSignedIn().then(valid => { if (!valid) controller.abort() }, () => controller.abort()) }, 5000)
            response.writeHead(200, { ...headers, "content-type": "text/event-stream" })
            response.flushHeaders()
            await pipeline(Readable.fromWeb(result.body), response, { signal: controller.signal })
            return
          }
          const body = await result.json()
          if (!await stillSignedIn()) return send(401, { error: "session_changed" })
          return send(result.status, body)
        } finally { clearTimeout(timer); clearInterval(revocation); controller.abort() }
      }
      if (request.method !== "GET") return send(405, { error: "method_not_allowed" })
      if (CONSOLE_ASSETS.has(url.pathname)) {
        // Only these public build outputs can run in the frame; the asset request carries no account credentials.
        const asset = await fetchImpl(new URL("/v1/dashboard/ui" + url.pathname, ORIGIN), { redirect: "error", signal: AbortSignal.timeout(15000) })
        const type = CONSOLE_ASSETS.get(url.pathname)
        if (!asset.ok || !asset.body || !(type === "text/javascript" ? /^(application|text)\/javascript$/ : /^text\/css$/).test(asset.headers.get("content-type")?.split(";")[0] ?? "")) return send(502, { error: "console_unavailable" })
        response.writeHead(200, { ...headers, "content-type": type })
        await pipeline(Readable.fromWeb(asset.body), response)
        return
      }
      const file = url.pathname === "/" ? "dashboard.html" : ASSETS.has(url.pathname) ? url.pathname.slice(1) : null
      if (!file) return send(404, { error: "not_found" })
      const content = await readFile(new URL(`./ui/${file}`, import.meta.url))
      response.writeHead(200, {
        ...headers,
        "content-type": url.pathname === "/" ? "text/html; charset=utf-8" : ASSETS.get(url.pathname),
        "content-security-policy": `default-src 'none'; script-src 'self' ${localOrigin}; style-src 'self' ${localOrigin} 'unsafe-inline'; img-src 'self' ${localOrigin} data:; connect-src 'self' ${localOrigin}; base-uri 'none'; form-action 'none'; frame-src 'none'`,
      })
      response.end(url.pathname === "/" ? content.toString("utf8").replace("<!--SESSION-->", `<meta name="zgap-page-token" content="${token}">`) : content)
    } catch (error) {
      // Upstream bodies and credentials never go into local errors or logs.
      if (response.destroyed || response.headersSent) return response.destroy()
      send(502, { error: "dashboard_unavailable" })
      console.error("ZGAP dashboard request failed:", error.name)
    }
  })
  // magpie keeps the plugin host it replaces (a Bun update, a plugin installed, updated or set) until
  // that host's replies end, up to 10 minutes, and the old host holds this port until then. Waiting
  // for it brings the page back without another restart.
  const listen = () => new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error) }
    const onListening = () => { server.off("error", onError); resolve() }
    server.once("error", onError).once("listening", onListening).listen(port, "127.0.0.1")
  })
  for (let waited = false; ; waited = true) {
    try {
      await listen()
      if (waited) console.error(`ZGAP page: port ${port} is free again`)
      break
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error
      if (!waited) console.error(`ZGAP page: port ${port} is in use, likely by the magpie plugin host being replaced; waiting for it`)
      await new Promise((resolve) => setTimeout(resolve, 1000).unref())
    }
  }
  server.unref()
  return server
}
