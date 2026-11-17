(async () => {
  if (!magpie.options) return
  await magpie.ready
  const options = await magpie.options.get()
  const port = options.port ?? globalThis.zgapDashboardPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid ZGAP dashboard port")
  location.replace(magpie.service || `http://127.0.0.1:${port}/`)
})()
