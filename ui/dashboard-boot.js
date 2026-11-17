// A failed deployment or offline gateway must offer a retry instead of leaving the frame on its loading screen.
(async () => {
  const theme = await magpie.ready
  const language = theme.lang?.split("-")[0]
  const strings = (zgapMessages[language] ?? zgapMessages.en).translation
  const status = document.getElementById("initializing")
  status.textContent = strings.loadingUsage
  function load(element) {
    return new Promise((resolve, reject) => {
      element.onload = resolve
      element.onerror = reject
      document.head.append(element)
    })
  }
  try {
    await load(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/console.css" }))
    await load(Object.assign(document.createElement("script"), { src: "/console.js" }))
  } catch {
    status.setAttribute("role", "alert")
    const retry = document.createElement("button")
    retry.textContent = strings.refresh
    retry.onclick = () => location.reload()
    status.replaceChildren(strings.loadFailed, retry)
  }
})()
