window.__ModuleLoader__.load({
  id: "dsh-duet",
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const inject = ["sessions", "conversation", "uiSession", "workspaces"]

    function apply(ctx) {
      ctx.effect(() => {
        let active = true
        let dispose
        import('/duet/assets/client/browser.mjs?v=0.1.4').then(module => {
          if (active) dispose = module.mountDuet(ctx)
        }).catch(error => console.warn('duet controls could not load:', error))
        return () => { active = false; dispose?.() }
      }, 'duet-client: three-state microphone and playback controls')
      ctx.effect(() => {
        const entryId = "dsh-duet-entry"

        const mountEntry = () => {
          if (document.getElementById(entryId) !== null) return
          const settingsSlot = document.querySelector('[data-slot="sidebar.settings"]')
          const settingsButton = settingsSlot?.querySelector("button")
          const settingsLabel = settingsSlot?.querySelector("span")
          if (settingsSlot === null || settingsSlot.parentElement === null || settingsButton == null) return

          const entry = document.createElement("span")
          entry.id = entryId
          entry.setAttribute("aria-label", "duet")
          entry.setAttribute("data-duet-surface", "control-entry")
          entry.style.textDecoration = "none"
          entry.style.marginBottom = "4px"

          const label = document.createElement("span")
          label.textContent = "duet"
          entry.style.fontWeight = "750"
          entry.style.letterSpacing = "-0.4px"
          entry.append(label)
          settingsSlot.parentElement.insertBefore(entry, settingsSlot)
        }

        mountEntry()
        const observer = new MutationObserver(mountEntry)
        observer.observe(document.body, { childList: true, subtree: true })
        return () => {
          observer.disconnect()
          document.getElementById(entryId)?.remove()
        }
      }, "duet-client: mount main page entry")

    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
