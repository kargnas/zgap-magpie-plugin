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
    </header>
    <section id="setup" class="setup" aria-labelledby="setup-title">
      <div class="section-heading"><div><h2 id="setup-title" data-i18n="setupTitle"></h2></div><span class="pill" data-i18n="noTerminal"></span></div>
      <p id="context" class="context" hidden></p>
      <ol class="steps">
        <li id="sign-in" tabindex="-1"><span class="step-number">01</span><div><h3 data-i18n="signInTitle"></h3><p class="path">Plugins <span>›</span> Installed <span>›</span> ZGAP <span>›</span> Sign in</p><p data-i18n="signInBody"></p></div></li>
        <li><span class="step-number">02</span><div><h3 data-i18n="approveTitle"></h3><p class="path" data-i18n="approvePath"></p><p data-i18n="approveBody"></p></div></li>
        <li id="agent" tabindex="-1"><span class="step-number">03</span><div><h3 data-i18n="agentTitle"></h3><p class="path">Agents <span>›</span> <span data-i18n="yourAgent"></span> <span>›</span> <span data-i18n="zgapModel"></span></p><p data-i18n="agentBody"></p></div></li>
      </ol>
    </section>
    <details class="privacy"><summary data-i18n="privacyTitle"></summary><p data-i18n="privacyBody"></p><p data-i18n="revokeBody"></p></details>
`

  let action
  function translate() {
    for (const el of app.querySelectorAll("[data-i18n]")) el.textContent = i18next.t(el.dataset.i18n)
    const context = document.getElementById("context")
    const name = action?.agent?.name || action?.provider?.name
    context.hidden = !name
    // A menu's row name is user-controlled; it is always text, never markup.
    context.textContent = name ? i18next.t("context", { name }) : ""
  }
  translate()
  magpie.onTheme(async ({ lang }) => { await i18next.changeLanguage(lang); translate() })
  document.getElementById("initializing").remove()
  app.hidden = false
  magpie.onAction((value) => {
    action = value
    translate()
    const target = document.getElementById(value.id === "agent-setup" ? "agent" : "sign-in")
    target.scrollIntoView({ block: "center" })
    target.focus({ preventScroll: true })
  })
}

start()
