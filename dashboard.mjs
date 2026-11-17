import http from "node:http"
import { readFile } from "node:fs/promises"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import path from "node:path"

const ORIGIN = "https://ai-proxy.zz.gg"
const ASSETS = new Map([
  ["/app.js", "text/javascript"], ["/dashboard-bridge.js", "text/javascript"],
  ["/messages.js", "text/javascript"], ["/style.css", "text/css"],
  ["/icon.svg", "image/svg+xml"], ["/vendor/i18next.min.js", "text/javascript"],
])

// The host supplies its actual config directory, including portable and isolated installations.
// Read only ZGAP entries; magpie alone writes, renews and removes these credentials.
export async function readAccounts(directory) {
  let text
  try { text = await readFile(path.join(directory, "plugin-auth.json"), "utf8") }
  catch (error) { if (error.code === "ENOENT") return []; throw error }
  const saved = JSON.parse(text)
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid magpie sign-in store")
  return Object.entries(saved).filter(([key, value]) => (key === "zgap" || key.startsWith("zgap#")) && value?.type === "oauth" && typeof value.access === "string" && value.access)
    .sort(([a], [b]) => a === "zgap" ? -1 : b === "zgap" ? 1 : a.localeCompare(b))
    .map(([key, auth]) => ({ id: createHash("sha256").update(key).digest("hex").slice(0, 20), label: typeof auth.accountId === "string" ? auth.accountId : "ZGAP", auth }))
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
        const publicAccounts = accounts.map(({ id, label }) => ({ id, label }))
        if (url.pathname === "/api/session") return send(200, { accounts: publicAccounts })
        if (!["/api/usage", "/api/live"].includes(url.pathname)) return send(404, { error: "not_found" })
        const selected = url.searchParams.get("account")
        const account = selected ? accounts.find(row => row.id === selected) : accounts[0]
        if (!account) return send(401, { error: "not_signed_in" })
        const upstream = new URL(url.pathname === "/api/live" ? "/v1/dashboard/live" : "/v1/dashboard", ORIGIN)
        if (url.pathname === "/api/usage") {
          upstream.search = new URLSearchParams({ days: url.searchParams.get("days") ?? "7", timeZone: url.searchParams.get("timeZone") ?? "UTC" })
        }
        const controller = new AbortController()
        response.on("close", () => controller.abort())
        const result = await fetchImpl(upstream, {
          headers: { accept: "application/json", authorization: `Bearer ${account.auth.access}` },
          redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        })
        const body = await result.json()
        // Sign-out or account replacement during a request must discard the old response.
        const current = (await readAccounts(directory)).find(row => row.id === account.id)
        if (!current || current.auth.access !== account.auth.access) return send(401, { error: "session_changed" })
        return send(result.status, body)
      }
      if (request.method !== "GET") return send(405, { error: "method_not_allowed" })
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
      if (!response.destroyed) send(502, { error: "dashboard_unavailable" })
      console.error("ZGAP dashboard request failed:", error.name)
    }
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve) })
  server.unref()
  return server
}
