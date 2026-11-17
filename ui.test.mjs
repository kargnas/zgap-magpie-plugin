import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import { ZgapPlugin } from "./index.mjs"

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8")
const pkg = JSON.parse(read("./package.json"))
const translations = Object.fromEntries(readdirSync(new URL("./locales/", import.meta.url)).map((file) => [file.slice(0, -5), JSON.parse(read(`./locales/${file}`))]))

test("shipped icon, translations and i18next match their source", () => {
  assert.equal(pkg.magpie.icon, `data:image/svg+xml;base64,${Buffer.from(read("./ui/icon.svg")).toString("base64")}`)
  const context = {}
  runInNewContext(read("./ui/messages.js"), context)
  assert.deepEqual(JSON.parse(JSON.stringify(context.zgapMessages)), Object.fromEntries(Object.entries(translations).map(([lang, translation]) => [lang, { translation }])))
  assert.equal(read("./ui/vendor/i18next.min.js"), read("./node_modules/i18next/dist/umd/i18next.min.js"))
})

test("every locale covers the UI, native labels and manifest limits", async () => {
  const { auth } = await ZgapPlugin()
  const keys = Object.keys(translations.en).sort()
  for (const [lang, strings] of Object.entries(translations)) {
    assert.ok(keys.every((key) => key in strings || key in translations.en), lang)
    assert.ok(Object.values(strings).every((value) => typeof value === "string" && value.trim()), lang)
    assert.equal(pkg.magpie.summary[lang], strings.summary)
    assert.ok(Buffer.byteLength(strings.summary) <= 300, lang)
    assert.equal(auth.methods[0].labels[lang], strings.signInLabel)
    for (const panel of pkg.magpie.panels) assert.equal(panel.titles[lang], strings.panelTitle)
    for (const action of pkg.magpie.actions) assert.equal(action.titles[lang], strings.menuTitle)
  }
  for (const [, key] of read("./ui/app.js").matchAll(/data-i18n="([^"]+)"/g)) assert.ok(key in translations.en, key)
})

test("window entry points and their assets ship together inside the page sandbox", () => {
  for (const entry of [pkg.magpie.page, ...pkg.magpie.panels]) {
    const html = read(`./${entry.file}`)
    assert.match(html, /_magpie\/bridge\.js/)
    for (const [, file] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (file === "_magpie/bridge.js") continue
      assert.ok(!file.includes("..") && !file.includes(":"), file)
      assert.ok(read(`./ui/${file}`).length, file)
    }
  }
  assert.ok(pkg.files.includes("ui") && pkg.files.includes("locales"))
  assert.ok(read("./ui/dashboard.html").includes("<!--SESSION-->"))
  assert.ok(read("./dashboard.mjs").includes("/v1/dashboard"))
  assert.equal(pkg.magpie.permissions, undefined)
})
