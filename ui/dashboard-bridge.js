// The hosted page uses the same documented handshake as magpie's static page bridge.
(() => {
  const themes = [], actions = [], visibility = []
  let resolve
  const api = { ready: new Promise(done => { resolve = done }), visible: true,
    onTheme: fn => themes.push(fn), onAction: fn => actions.push(fn), onVisibility: fn => visibility.push(fn) }
  function paint(theme) {
    document.documentElement.dataset.theme = theme.dark ? "dark" : "light"
    document.documentElement.lang = theme.lang || "en"
    document.documentElement.style.colorScheme = theme.dark ? "dark" : "light"
    for (const [key, value] of Object.entries(theme.tokens ?? {})) document.documentElement.style.setProperty(`--magpie-${key}`, value)
  }
  addEventListener("message", event => {
    if (event.source !== parent || event.data?.magpie !== 1) return
    const message = event.data
    if (message.id === "zgap-dashboard" && message.result) {
      paint(message.result); api.visible = message.result.visible !== false; resolve(message.result)
    }
    if (message.event === "theme") { paint(message.data); for (const fn of themes) fn(message.data) }
    if (message.event === "action") for (const fn of actions) fn(message.data)
    if (message.event === "visibility") { api.visible = message.data.visible; for (const fn of visibility) fn(api.visible) }
  })
  window.magpie = api
  parent.postMessage({ magpie: 1, id: "zgap-dashboard", method: "hello" }, "*")
})()
