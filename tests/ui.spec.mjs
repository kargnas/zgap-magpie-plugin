import { test, expect } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../ui")
const bridge = `
let done; const themes=[]; let action;
window.magpie={ready:new Promise(r=>done=r),onTheme:f=>themes.push(f),onAction:f=>action=f};
addEventListener('message',e=>{if(e.source!==parent)return; const m=e.data;
if(m.theme){document.documentElement.dataset.theme=m.theme.dark?'dark':'light'; document.documentElement.lang=m.theme.lang;done(m.theme);themes.forEach(f=>f(m.theme));}
if(m.action)action?.(m.action);}); parent.postMessage('ready','*');`

async function mount(page, file = "dashboard.html") {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("http://magpie.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><style>body{margin:0}iframe{display:block;border:0;width:100%;height:1500px}</style><script>addEventListener('message',e=>{if(e.data==='ready')e.source.postMessage({theme:{dark:false,lang:'en'}},'*')})</script><iframe sandbox="allow-scripts" src="/ui/${file}"></iframe>` })
    if (pathname.endsWith("/_magpie/bridge.js") || pathname.endsWith("/dashboard-bridge.js")) return route.fulfill({ contentType: "text/javascript", body: bridge })
    const relative = pathname.replace(/^\/ui\//, "")
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(relative)]
    await route.fulfill({ contentType, body: await readFile(path.join(root, relative)), headers: { "Content-Security-Policy": "default-src 'none'; script-src http://magpie.test/ui/; style-src http://magpie.test/ui/ 'unsafe-inline'; img-src http://magpie.test/ui/ data:; connect-src 'none'; sandbox allow-scripts" } })
  })
  await page.goto("http://magpie.test/")
  const frame = page.frameLocator("iframe")
  await expect(frame.locator("#app")).toBeVisible()
  return { frame, errors }
}

test("seven languages, dark theme, mobile layout and safe menu context", async ({ page }) => {
  const { frame, errors } = await mount(page)
  await expect(frame.locator("#headline")).toContainText("One sign-in.")
  for (const lang of ["en", "ko", "zh", "ja", "es", "de", "fr"]) {
    await page.evaluate((lang) => document.querySelector("iframe").contentWindow.postMessage({ theme: { lang, dark: true } }, "*"), lang)
    await expect(frame.locator("html")).toHaveAttribute("lang", lang)
    await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark")
    await page.setViewportSize({ width: 375, height: 900 })
    await expect.poll(() => frame.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth)).toBe(true)
    await expect(frame.locator("#headline")).not.toHaveText(/headline/)
  }
  await page.evaluate(() => document.querySelector("iframe").contentWindow.postMessage({ action: { id: "agent-setup", agent: { name: '<img src=x onerror="alert(1)">' } } }, "*"))
  await expect(frame.locator("#context")).toContainText('<img src=x onerror="alert(1)">')
  await expect(frame.locator("#context img")).toHaveCount(0)
  await expect(frame.locator("#agent")).toBeFocused()
  await frame.locator("summary").click()
  await expect(frame.locator("details")).toHaveAttribute("open", "")
  expect(errors).toEqual([])
})

test("settings panel keeps the steps and removes the large hero", async ({ page }) => {
  const { frame, errors } = await mount(page, "panel.html")
  await expect(frame.locator(".hero")).toBeHidden()
  await expect(frame.locator(".steps li")).toHaveCount(3)
  await expect(frame.locator(".privacy")).toBeVisible()
  expect(errors).toEqual([])
})
