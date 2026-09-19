window.__ModuleLoader__.load({
  id: "dsh-duet",
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const inject = ["sessions", "conversation", "uiSession"]

    function apply(ctx) {
      const focusedSession = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        if ('current' in snapshot) return snapshot.current || null
        const selected = Object.entries(snapshot.byId || {}).filter(([, row]) => row.retainedBy?.mainView > 0)
        return selected.length === 1 ? selected[0][0] : null
      }
      const browserClientId = crypto.randomUUID()
      // A hung fetch must not permanently hold heartbeatRunning/pollRunning.
      const bridgeFetch = async (url, options = {}, timeoutMs = 8000) => {
        const request = new AbortController()
        const abort = () => request.abort()
        options.signal?.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted) abort()
        const timer = setTimeout(abort, timeoutMs)
        try { return await fetch(url, { ...options, signal: request.signal }) }
        finally {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', abort)
        }
      }
      ctx.effect(() => {
        let active = true
        let dispose
        import('/duplex-control/deepseek_harness_voice_browser.mjs?v=0.1.0').then(module => {
          if (active) dispose = module.mountVoice(ctx)
        }).catch(error => console.warn('Duplex voice controls could not load:', error))
        return () => { active = false; dispose?.() }
      }, 'duplex-voice-client: three-state microphone and playback controls')
      ctx.effect(() => {
        const entryId = "dsh-duplex-control-entry"

        const mountEntry = () => {
          if (document.getElementById(entryId) !== null) return
          const settingsSlot = document.querySelector('[data-slot="sidebar.settings"]')
          const settingsButton = settingsSlot?.querySelector("button")
          const settingsLabel = settingsSlot?.querySelector("span")
          if (settingsSlot === null || settingsSlot.parentElement === null || settingsButton == null) return

          const entry = document.createElement("span")
          entry.id = entryId
          entry.setAttribute("aria-label", "duet")
          entry.setAttribute("data-duplex-surface", "control-entry")
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
      }, "duplex-control-client: mount main page entry")

      ctx.effect(() => {
        if (typeof BroadcastChannel === "undefined") return () => {}
        const channel = new BroadcastChannel("dsh-duplex-control-v1")

        const currentComposer = () => {
          const sessionId = focusedSession()
          if (typeof sessionId !== "string") throw new Error("Harness currently has no selected session")
          const sessionContext = ctx.sessions.scope(sessionId)
          if (sessionContext === undefined) throw new Error(`Harness session ${sessionId} is not ready`)
          return {
            sessionId,
            input: ctx.conversation.input.for(sessionContext),
          }
        }

        const composerState = (sessionId, input) => {
          const state = input.state.getSnapshot()
          return {
            session_id: sessionId,
            draft: state.draft,
            phase: state.phase,
            draft_revision: state.draftRev,
          }
        }

        channel.onmessage = (event) => {
          const message = event.data
          if (
            message === null
            || typeof message !== "object"
            || message.source !== "duplex-control-page"
            || typeof message.request_id !== "string"
          ) return
          if (!["composer/get", "composer/set", "composer/clear"].includes(message.type)) return

          const respond = (payload) => channel.postMessage({
            source: "harness-main-page",
            type: "composer/result",
            request_id: message.request_id,
            ...payload,
          })

          try {
            const { sessionId, input } = currentComposer()
            if (message.type === "composer/set") {
              const text = String(message.text ?? "")
              if (text.length > 100_000) throw new Error("Draft is too large")
              const before = input.state.getSnapshot()
              if (before.phase !== "plain") {
                throw new Error(`Harness input is busy (${before.phase})`)
              }
              input.setDraft(message.mode === "append" ? `${before.draft}${text}` : text)
            } else if (message.type === "composer/clear") {
              const before = input.state.getSnapshot()
              if (before.phase !== "plain") {
                throw new Error(`Harness input is busy (${before.phase})`)
              }
              input.setDraft("")
            }
            respond({ ok: true, composer: composerState(sessionId, input) })
          } catch (error) {
            respond({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }

        return () => channel.close()
      }, "duplex-control-client: bridge current composer")

      ctx.effect(() => {
        const controller = new AbortController()
        const clientId = browserClientId
        let pollRunning = false
        let retryTimer

        const digest = async (text) => {
          const bytes = new TextEncoder().encode(text)
          const hash = await crypto.subtle.digest("SHA-256", bytes)
          return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("")
        }

        const composerForSession = async (sessionId) => {
          await ctx.sessions.refresh()
          const sessionContext = ctx.sessions.scope(sessionId)
          if (sessionContext === undefined) {
            const error = new Error(`Harness session ${sessionId} is not ready`)
            error.code = "session_not_ready"
            throw error
          }
          return ctx.conversation.input.for(sessionContext)
        }

        const composerState = async (sessionId, input) => {
          const state = input.state.getSnapshot()
          return {
            session_id: sessionId,
            text: state.draft,
            phase: state.phase,
            revision: state.draftRev,
            hash: await digest(state.draft),
          }
        }

        const execute = async (request) => {
          const input = await composerForSession(request.session_id)
          const before = await composerState(request.session_id, input)
          const checkFocus = () => {
            if (request.require_focus && focusedSession() !== request.session_id) {
              const error = new Error("Focused session changed; read input_status again")
              error.code = "focus_conflict"
              throw error
            }
          }
          checkFocus()
          if (["set", "clear", "consume"].includes(request.type)) {
            const overwrite = request.type === "set" && request.overwrite === true
            if (before.phase !== "plain") {
              const error = new Error(`Harness input is busy (${before.phase})`)
              error.code = "composer_busy"
              throw error
            }
            if (!overwrite && (
              before.revision !== request.expected_revision
              || before.hash !== request.expected_hash
            )) {
              const error = new Error("Harness input changed before the requested edit")
              error.code = "draft_conflict"
              throw error
            }
            // Hashing yields to the browser. Recheck the live draft immediately before
            // the synchronous write so a keystroke during hashing cannot be overwritten.
            const live = input.state.getSnapshot()
            if (!overwrite && (live.draftRev !== before.revision || live.draft !== before.text || live.phase !== before.phase)) {
              const error = new Error("Harness input changed during snapshot")
              error.code = "draft_conflict"
              throw error
            }
            if (live.phase !== "plain") {
              const error = new Error("Harness input is busy")
              error.code = "composer_busy"
              throw error
            }
            checkFocus()
            // DSH 0.1.5 adds generic attachments. The host submit RPC below is
            // text-only: do not clear/send just the text and silently omit files.
            // Older DSH exposes the same browser-owned items as imageIds.
            if (request.type === "consume" && (live.attachmentIds ?? live.imageIds ?? []).length > 0) {
              const error = new Error("输入框含有附件，请在 Harness 页面发送；语音发送目前只支持纯文本")
              error.code = "composer_attachments_unsupported"
              throw error
            }
            const consumed = request.type === "consume" ? before : null
            input.setDraft(["clear", "consume"].includes(request.type) ? "" : String(request.text ?? ""))
            await new Promise(resolve => setTimeout(resolve, 0))
            const after = await composerState(request.session_id, input)
            if (consumed !== null) {
              return {
                ...after,
                consumed_text: consumed.text,
                consumed_revision: consumed.revision,
                consumed_hash: consumed.hash,
              }
            }
            return after
          } else if (request.type !== "get") {
            const error = new Error(`Unsupported composer request: ${request.type}`)
            error.code = "unsupported_composer_operation"
            throw error
          }
          return before
        }

        const complete = async (requestId, payload) => {
          await bridgeFetch(`/duplex-control/api/composer/requests/${encodeURIComponent(requestId)}/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: clientId, ...payload }),
            cache: "no-store",
            signal: controller.signal,
          })
        }

        const processRequest = async (candidate) => {
          const claimResponse = await bridgeFetch(
            `/duplex-control/api/composer/requests/${encodeURIComponent(candidate.id)}/claim`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ client_id: clientId }),
              cache: "no-store",
              signal: controller.signal,
            },
          )
          if (claimResponse.status === 404 || claimResponse.status === 409) return
          if (!claimResponse.ok) throw new Error(`Composer claim failed: HTTP ${claimResponse.status}`)
          const request = (await claimResponse.json()).request
          try {
            const composer = await execute(request)
            await complete(request.id, { ok: true, composer })
          } catch (error) {
            await complete(request.id, {
              ok: false,
              error_code: error?.code || "composer_operation_failed",
              error: error instanceof Error ? error.message : String(error),
              status: error?.code === "session_not_ready" ? 503 : 409,
            })
          }
        }

        const poll = async () => {
          if (pollRunning || controller.signal.aborted) return
          clearTimeout(retryTimer)
          pollRunning = true
          let succeeded = false
          try {
            const sessionId = focusedSession() || ''
            const visibility = typeof document === 'undefined' ? 'unknown' : document.visibilityState
            const query = `wait=1&client_id=${encodeURIComponent(clientId)}&session_id=${encodeURIComponent(sessionId)}&visibility=${encodeURIComponent(visibility)}`
            const response = await bridgeFetch(`/duplex-control/api/composer/requests?${query}`, {
              cache: "no-store",
              signal: controller.signal,
            }, 30_000)
            if (!response.ok) return
            const payload = await response.json()
            await Promise.all((payload.requests || []).map(processRequest))
            // Old hosts return an immediate empty list: retain a retry delay
            // rather than spinning if a browser/host upgrade is staggered.
            succeeded = payload.long_poll_supported === true
          } catch (error) {
            if (!controller.signal.aborted) console.warn("duplex composer RPC failed:", error)
          } finally {
            pollRunning = false
            if (!controller.signal.aborted) {
              // Successful long polls re-arm without a background-tab timer.
              if (succeeded) void poll()
              else retryTimer = setTimeout(() => { void poll() }, 1000)
            }
          }
        }

        void poll()
        const resume = () => { void poll() }
        window.addEventListener?.('online', resume)
        window.addEventListener?.('pageshow', resume)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume)
        return () => {
          controller.abort()
          clearTimeout(retryTimer)
          window.removeEventListener?.('online', resume)
          window.removeEventListener?.('pageshow', resume)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume)
        }
      }, "duplex-control-client: bridge server composer RPC")

      ctx.effect(() => {
        const controller = new AbortController()
        const focusClientId = browserClientId
        let lastEpoch
        let lastRevision = -1
        let lastPublishedSession
        let pollRunning = false
        let heartbeatRunning = false
        let publishRunning = false
        let publishPending = false
        let publishReady = false

        const selectedSession = focusedSession

        const observeEpoch = (epoch) => {
          if (typeof epoch !== "string" || epoch === lastEpoch) return
          lastEpoch = epoch
          lastRevision = -1
          lastPublishedSession = undefined
        }

        const heartbeat = async () => {
          if (heartbeatRunning) return
          heartbeatRunning = true
          try {
            const response = await bridgeFetch("/duplex-control/api/browser-clients/heartbeat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                client_id: focusClientId,
                session_id: selectedSession(),
                visibility: document.visibilityState,
              }),
              cache: "no-store",
              signal: controller.signal,
            })
            if (response.ok) observeEpoch((await response.json()).focus_epoch)
          } catch (error) {
            if (!controller.signal.aborted) console.warn("duplex heartbeat failed:", error)
          } finally {
            heartbeatRunning = false
          }
        }

        const publishSelection = async () => {
          if (!publishReady) return
          if (publishRunning) {
            publishPending = true
            return
          }
          publishRunning = true
          try {
            do {
              publishPending = false
              const sessionId = selectedSession()
              if (sessionId === lastPublishedSession) continue
              const response = await bridgeFetch("/duplex-control/api/focus", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: sessionId }),
                cache: "no-store",
                signal: controller.signal,
              })
              if (!response.ok) {
                const payload = await response.json().catch(() => ({}))
                throw new Error(payload.detail || `HTTP ${response.status}`)
              }
              lastPublishedSession = sessionId
            } while (publishPending)
          } catch (error) {
            if (!controller.signal.aborted) console.warn("duplex selection publish failed:", error)
          } finally {
            publishRunning = false
          }
        }

        const poll = async () => {
          if (pollRunning) return
          pollRunning = true
          try {
            const response = await bridgeFetch("/duplex-control/api/focus", {
              cache: "no-store",
              signal: controller.signal,
            })
            if (!response.ok) return
            const focus = await response.json()
            observeEpoch(focus.focus_epoch)
            if (!Number.isInteger(focus.revision) || focus.revision <= lastRevision) return
            if (focus.revision === 0 || typeof focus.session_id !== "string") {
              lastRevision = focus.revision
              return
            }
            await ctx.sessions.refresh()
            if (ctx.sessions.list.getSnapshot().byId[focus.session_id] === undefined) return
            lastPublishedSession = focus.session_id
            // New DSH separates controller selection from the visible panel.
            // Use the UI navigation API so a selected session is not hidden
            // behind the empty-workspace/settings panel while RPC edits it.
            const navigation = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : ctx.uiWorkspace
            if (navigation?.openSession) navigation.openSession(focus.session_id)
            else ctx.sessions.open(focus.session_id)
            lastRevision = focus.revision
          } catch (error) {
            if (!controller.signal.aborted) console.warn("duplex focus sync failed:", error)
          } finally {
            pollRunning = false
          }
        }

        const unsubscribe = ctx.sessions.list.subscribe(() => { void publishSelection() })
        void poll().finally(() => {
          publishReady = true
          void publishSelection()
        })
        void heartbeat()
        const timer = setInterval(() => {
          void poll()
          void publishSelection()
        }, 500)
        const heartbeatTimer = setInterval(() => { void heartbeat() }, 1000)
        const onVisibilityChange = () => { void heartbeat(); void poll(); void publishSelection() }
        document.addEventListener("visibilitychange", onVisibilityChange)
        window.addEventListener?.('online', onVisibilityChange)
        window.addEventListener?.('pageshow', onVisibilityChange)
        return () => {
          controller.abort()
          clearInterval(timer)
          clearInterval(heartbeatTimer)
          document.removeEventListener("visibilitychange", onVisibilityChange)
          window.removeEventListener?.('online', onVisibilityChange)
          window.removeEventListener?.('pageshow', onVisibilityChange)
          unsubscribe()
        }
      }, "duplex-focus-client: synchronize host and browser focus")
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
