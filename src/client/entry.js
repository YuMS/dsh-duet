window.__ModuleLoader__.load({
  id: "dsh-duet",
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const inject = ["sessions", "conversation", "uiSession", "workspaces"]

    function apply(ctx) {
      let loadFailure = false
      let showLoadFailure = () => {}
      ctx.effect(() => {
        let active = true
        let dispose
        import('/duet/assets/client/browser.mjs?v=0.2.0').then(module => {
          if (active) dispose = module.mountDuet(ctx)
        }).catch(error => {
          console.warn('duet controls could not load:', error)
          if (!active) return
          loadFailure = true
          showLoadFailure()
        })
        return () => { active = false; dispose?.() }
      }, 'duet-client: three-state microphone and playback controls')
      ctx.effect(() => {
        const entryId = "dsh-duet-entry"

        // Keep this fallback self-contained: the browser module or its dependencies
        // may be unavailable while an older DSH host is still running.
        showLoadFailure = () => {
          const entry = document.getElementById(entryId)
          if (!loadFailure || !entry || entry.querySelector('[data-duet-load-error]')) return
          const notice = document.createElement('span')
          notice.setAttribute('data-duet-load-error', '')
          notice.setAttribute('role', 'status')
          notice.textContent = 'duet 加载失败，请刷新页面；如刚更新插件，请重启 DSH。'
          notice.style.cssText = 'display:block;font-size:12px;line-height:1.5;font-weight:400;letter-spacing:normal;white-space:normal;overflow-wrap:anywhere;margin-top:4px;color:var(--foreground,currentColor)'
          entry.style.whiteSpace = 'normal'
          entry.append(notice)
        }

        const mountEntry = () => {
          if (document.getElementById(entryId) !== null) { showLoadFailure(); return }
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
          showLoadFailure()
        }

        mountEntry()
        const observer = new MutationObserver(mountEntry)
        observer.observe(document.body, { childList: true, subtree: true })
        return () => {
          showLoadFailure = () => {}
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
