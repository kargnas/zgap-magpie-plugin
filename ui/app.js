/* The sandbox supplies theme and menu context. Sign-in stays in magpie's native account UI. */
async function start() {
  const theme = await magpie.ready
  await i18next.init({
    lng: theme.lang, fallbackLng: "en", resources: globalThis.zgapMessages,
    interpolation: { escapeValue: false },
  })
  const app = document.getElementById("app")
  app.innerHTML = `
    <header class="masthead">
      <div class="brand"><img src="icon.svg" width="36" height="36" alt=""><strong>ZGAP</strong><span class="edition">for magpie</span></div>
      <span class="endpoint">ai-proxy.zz.gg</span>
    </header>
    <section id="activity" hidden aria-labelledby="activity-title">
      <div class="section-heading"><div><p class="eyebrow" data-i18n="activityEyebrow"></p><h1 id="activity-title" data-i18n="activityTitle"></h1><p id="account-email"></p></div><span id="live-status" class="pill" role="status"></span></div>
      <div class="activity-toolbar"><label><span data-i18n="account"></span><select id="account-select"></select></label><div class="periods" role="group" data-i18n-aria="period"><button type="button" data-days="1" data-i18n="day"></button><button type="button" data-days="7" aria-pressed="true" data-i18n="week"></button><button type="button" data-days="30" data-i18n="month"></button></div><button type="button" id="refresh" data-i18n="refresh"></button></div>
      <div id="usage-loading" class="loading-line" role="status" hidden><span class="spinner" aria-hidden="true"></span><span data-i18n="loadingUsage"></span></div>
      <p id="usage-error" class="error-message" role="alert" hidden></p>
      <div id="usage-content" hidden>
        <dl class="metrics"><div><dt data-i18n="requests"></dt><dd id="requests"></dd></div><div><dt data-i18n="cost"></dt><dd id="cost"></dd></div><div><dt data-i18n="inputTokens"></dt><dd id="input-tokens"></dd></div><div><dt data-i18n="outputTokens"></dt><dd id="output-tokens"></dd></div></dl>
        <p id="cost-note" class="caption" data-i18n="costNote"></p>
        <section class="activity-block"><h2 data-i18n="dailyRequests"></h2><ol id="trend" class="trend"></ol></section>
        <section class="activity-block"><h2 data-i18n="modelsTitle"></h2><div class="table-scroll"><table><thead><tr><th data-i18n="model"></th><th data-i18n="requests"></th><th data-i18n="outputTokens"></th><th data-i18n="cost"></th></tr></thead><tbody id="model-rows"></tbody></table></div></section>
      </div>
      <section class="activity-block"><div class="section-heading"><h2 data-i18n="liveTitle"></h2><span id="live-count" class="pill"></span></div><p class="caption" data-i18n="liveNote"></p><p id="live-error" class="error-message" role="alert" hidden></p><div class="table-scroll"><table><thead><tr><th data-i18n="model"></th><th data-i18n="state"></th><th data-i18n="duration"></th></tr></thead><tbody id="live-rows"></tbody></table></div></section>
      <button type="button" id="show-guide" class="guide-toggle" data-i18n="showGuide"></button>
    </section>
    <section class="hero page-only" aria-labelledby="headline">
      <div class="hero-copy">
        <p class="eyebrow" data-i18n="eyebrow"></p>
        <h1 id="headline"><span data-i18n="headline"></span><br><span data-i18n="headlineEnd"></span></h1>
        <p class="lede" data-i18n="intro"></p>
        <a class="start" href="#setup"><span data-i18n="start"></span><span aria-hidden="true">↗</span></a>
      </div>
      <div class="connection-art" aria-hidden="true">
        <div class="orbit orbit-one"></div><div class="orbit orbit-two"></div>
        <span class="node node-top">&gt;_</span><span class="node node-bottom">{ }</span>
        <img src="icon.svg" width="128" height="128" alt="">
        <span class="connection-label">ZGAP × magpie</span>
      </div>
    </section>
    <section id="setup" class="setup" aria-labelledby="setup-title">
      <div class="section-heading"><div><p class="eyebrow" data-i18n="setupEyebrow"></p><h2 id="setup-title" data-i18n="setupTitle"></h2></div><span class="pill" data-i18n="noTerminal"></span></div>
      <p id="context" class="context" hidden></p>
      <ol class="steps">
        <li id="sign-in" tabindex="-1"><span class="step-number">01</span><div><h3 data-i18n="signInTitle"></h3><p class="path">Plugins <span>›</span> Installed <span>›</span> ZGAP <span>›</span> Sign in</p><p data-i18n="signInBody"></p></div></li>
        <li><span class="step-number">02</span><div><h3 data-i18n="approveTitle"></h3><p class="path" data-i18n="approvePath"></p><p data-i18n="approveBody"></p></div></li>
        <li id="agent" tabindex="-1"><span class="step-number">03</span><div><h3 data-i18n="agentTitle"></h3><p class="path">Agents <span>›</span> <span data-i18n="yourAgent"></span> <span>›</span> <span data-i18n="zgapModel"></span></p><p data-i18n="agentBody"></p></div></li>
      </ol>
    </section>
    <section class="notes page-only" aria-label="ZGAP information">
      <article><span class="note-mark" aria-hidden="true">↻</span><h3 data-i18n="renewTitle"></h3><p data-i18n="renewBody"></p></article>
      <article><span class="note-mark" aria-hidden="true">≡</span><h3 data-i18n="catalogTitle"></h3><p data-i18n="catalogBody"></p></article>
    </section>
    <details class="privacy"><summary data-i18n="privacyTitle"></summary><p data-i18n="privacyBody"></p><p data-i18n="revokeBody"></p></details>
    <footer><span data-i18n="footer"></span><span class="wordmark">ZGAP ↗</span></footer>`

  let action
  function translate() {
    for (const el of app.querySelectorAll("[data-i18n]")) el.textContent = i18next.t(el.dataset.i18n)
    for (const el of app.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", i18next.t(el.dataset.i18nAria))
    app.querySelector(".notes").setAttribute("aria-label", i18next.t("infoLabel"))
    const context = document.getElementById("context")
    const name = action?.agent?.name || action?.provider?.name
    context.hidden = !name
    // A menu's row name is user-controlled; it is always text, never markup.
    context.textContent = name ? i18next.t("context", { name }) : ""
  }
  translate()
  let redraw = () => {}
  magpie.onTheme(async ({ lang }) => { await i18next.changeLanguage(lang); translate(); redraw() })
  if (document.querySelector('meta[name="zgap-page-token"]')) redraw = await dashboard(app)
  document.getElementById("initializing").remove()
  app.hidden = false
  magpie.onAction((value) => {
    action = value
    app.classList.add("show-guide")
    translate()
    const target = document.getElementById(value.id === "agent-setup" ? "agent" : "sign-in")
    target.scrollIntoView({ block: "center" })
    target.focus({ preventScroll: true })
  })
}

async function dashboard(app) {
  const $ = id => document.getElementById(id)
  const pageToken = document.querySelector('meta[name="zgap-page-token"]').content
  let account = "", days = "7", generation = 0, lastUsage = 0, usage, live, timer, controller, busy = false
  const number = value => new Intl.NumberFormat(i18next.language).format(value)
  const money = value => value === null ? "—" : new Intl.NumberFormat(i18next.language, { style: "currency", currency: "USD", maximumFractionDigits: value && value < .01 ? 4 : 2 }).format(value)
  function rows(target, values) {
    $(target).replaceChildren(...values.map(values => {
      const row = document.createElement("tr")
      for (const text of values) { const cell = document.createElement("td"); cell.textContent = text; row.append(cell) }
      return row
    }))
  }
  function render() {
    if (usage) {
      $("account-email").textContent = usage.email
      for (const [id, value] of [["requests", usage.requests], ["input-tokens", usage.inputTokens], ["output-tokens", usage.outputTokens]]) $(id).textContent = number(value)
      $("cost").textContent = money(usage.costUsd)
      $("cost-note").textContent = i18next.t(usage.incomplete ? "costIncomplete" : "costNote")
      const maximum = Math.max(1, ...usage.days.map(row => row.requests))
      $("trend").replaceChildren(...usage.days.map(row => {
        const item = document.createElement("li"), bar = document.createElement("div"), label = document.createElement("span")
        bar.style.setProperty("--value", `${row.requests / maximum * 100}%`)
        bar.setAttribute("aria-label", `${row.date}: ${number(row.requests)}`)
        bar.title = `${row.date}: ${number(row.requests)}`
        label.textContent = row.date.slice(5)
        item.append(bar, label); return item
      }))
      if (!usage.days.length) $("trend").textContent = i18next.t("noRequests")
      rows("model-rows", usage.models.length ? usage.models.map(row => [row.model, number(row.requests), number(row.outputTokens), money(row.costUsd)]) : [[i18next.t("noRequests"), "", "", ""]])
    }
    if (live) {
      $("account-email").textContent = live.email
      $("live-count").textContent = i18next.t("inFlight", { count: live.inflight.length })
      const items = [...live.inflight, ...live.recent].slice(0, 20)
      rows("live-rows", items.length ? items.map(row => [row.model || "—", row.state || "—", row.durationMs == null ? "—" : `${number(Math.round(row.durationMs))} ms`]) : [[i18next.t("noLive"), "", ""]])
      $("live-status").textContent = i18next.t("updated", { time: new Date().toLocaleTimeString(i18next.language) })
    }
  }
  async function api(route, signal) {
    const response = await fetch(new URL(`api/${route}`, location.href), { headers: { "x-zgap-page-token": pageToken }, signal })
    if (!response.ok) throw Object.assign(new Error("Dashboard request failed"), { status: response.status })
    return response.json()
  }
  function signedOut() {
    account = ""; usage = live = undefined
    $("activity").hidden = true
    app.classList.remove("signed-in", "show-guide")
    $("usage-content").hidden = true
    rows("live-rows", [])
  }
  async function refresh(force = false) {
    if (busy && !force) return
    if (!magpie.visible) return
    busy = true
    const current = ++generation
    controller?.abort(); controller = new AbortController()
    const signal = controller.signal
    try {
      const session = await api("session", signal)
      if (current !== generation) return
      if (!session.accounts.length) { signedOut(); return }
      const next = session.accounts.find(row => row.id === account) ?? session.accounts[0]
      if (next.id !== account) { usage = live = undefined; lastUsage = 0; account = next.id; rows("live-rows", []); $("usage-content").hidden = true }
      $("account-select").replaceChildren(...session.accounts.map(row => { const option = new Option(row.label, row.id); option.selected = row.id === account; return option }))
      const needUsage = force || !usage || Date.now() - lastUsage >= 30000
      if (needUsage) { usage = undefined; $("usage-content").hidden = true; $("usage-loading").hidden = false; $("usage-error").hidden = true }
      live = undefined; rows("live-rows", []); $("live-error").hidden = true
      $("live-status").textContent = i18next.t("loadingUsage")
      const query = new URLSearchParams({ account, days, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      const results = await Promise.allSettled([api(`live?${query}`, signal), ...(needUsage ? [api(`usage?${query}`, signal)] : [])])
      if (current !== generation) return
      if (results.some(result => result.status === "rejected" && [401, 403].includes(result.reason.status))) { signedOut(); return }
      $("activity").hidden = false; app.classList.add("signed-in")
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") {
          if (index === 0) live = result.value
          else { usage = result.value; lastUsage = Date.now(); $("usage-content").hidden = false }
        } else {
          const error = $(index === 0 ? "live-error" : "usage-error")
          error.hidden = false; error.textContent = i18next.t("loadFailed")
          if (index === 0) $("live-status").textContent = i18next.t("offline")
        }
      }
      render()
    } catch (error) {
      if (current !== generation || signal.aborted) return
      $("activity").hidden = false; app.classList.add("signed-in")
      usage = live = undefined; $("usage-content").hidden = true; rows("live-rows", [])
      $("usage-error").hidden = false; $("usage-error").textContent = i18next.t("loadFailed")
    } finally {
      if (current === generation) { busy = false; $("usage-loading").hidden = true; $("refresh").disabled = false }
    }
  }
  $("account-select").setAttribute("aria-label", i18next.t("account"))
  $("account-select").onchange = event => { account = event.target.value; usage = live = undefined; lastUsage = 0; void refresh(true) }
  for (const button of app.querySelectorAll("[data-days]")) button.onclick = () => {
    days = button.dataset.days
    for (const other of app.querySelectorAll("[data-days]")) other.setAttribute("aria-pressed", String(other === button))
    void refresh(true)
  }
  $("refresh").onclick = () => { $("refresh").disabled = true; void refresh(true) }
  $("show-guide").onclick = () => app.classList.toggle("show-guide")
  const schedule = visible => {
    clearInterval(timer)
    if (visible) { void refresh(); timer = setInterval(() => void refresh(), 5000) }
    else { ++generation; busy = false; controller?.abort() }
  }
  magpie.onVisibility(schedule)
  await refresh()
  schedule(magpie.visible)
  return render
}
start()
