/**
 * The editor tab host: resolves a file's previewer through the sidebar
 * registry (`matchFileViewer`), fetches bytes per the matched viewer's
 * fetch strategy, and renders its component — or the shared download pane
 * when nothing can render the file. The header shows the file title; the
 * editable code/markdown viewers render their own toolbar below it.
 *
 * The strategy dispatch is pure (planFirstMatch / planFsReadOutcome in
 * editor-load.ts); this component only wires it to the host APIs.
 */
import { useEffect, useRef, useState } from 'react'
import { createElement } from 'react'
import { IconChevronLeftOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { api, mediaUrl, SidebarApiError, type SessionScope } from './api.ts'
import { BinaryDownload } from './binary-download.tsx'
import { planFirstMatch, planFsReadOutcome, type EditorLoadAction } from './editor-load.ts'
import { nextDelayMs } from './chunk-availability.ts'
import { t } from './locales.ts'
import type { FileViewerDescriptor } from './service.ts'
import type { SidebarStore } from './state.ts'
import css from './sidebar.module.css'

type EditorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string; retryable?: boolean; autoAttempt?: number }
  | { status: 'ready'; viewer: FileViewerDescriptor; content?: string; truncated?: boolean; mediaUrl?: string; customData?: unknown }
  | { status: 'binary' }

export function EditorHost(props: { ctx: Context; store: SidebarStore; scope: SessionScope; path: string; title: string; tabId?: string; visible?: boolean }) {
  const { ctx, store, scope, path, title, tabId } = props
  /** 返回上级：切回资源管理器（若打开）并关闭当前文件预览标签。 */
  const goBack = () => {
    const service = ctx.betterSidebar
    if (service === undefined || tabId === undefined) return
    service.activateTab('explorer', scope)
    service.closeTab(tabId, scope)
  }
  const [load, setLoad] = useState<EditorLoad>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const failCountRef = useRef(0)
  const failKeyRef = useRef('')
  const loadRef = useRef(load)
  loadRef.current = load
  const visible = props.visible !== false
  const prevVisibleRef = useRef(visible)
  useEffect(() => {
    // Re-activating a tab whose load ended in an error re-triggers the fetch
    // (a re-click on the same file must never stay stuck on a dead error).
    if (!prevVisibleRef.current && visible && loadRef.current.status === 'error') {
      setAttempt(a => a + 1)
    }
    prevVisibleRef.current = visible
  }, [visible])

  useEffect(() => {
    let cancelled = false
    let retryTimer: number | undefined
    // Aborts the matched viewer's `load` when the editor tears down (tab
    // closed, path changed, session switched) or re-matches the viewer.
    const controller = new AbortController()
    setLoad({ status: 'loading' })
    const succeed = (): void => { failCountRef.current = 0 }
    const fail = (error: unknown): void => {
      if (cancelled) return
      const retryable = error instanceof SidebarApiError && (error.code === 'network' || error.code === 'http')
      const key = `${scope.sessionId}|${path}`
      if (failKeyRef.current !== key) {
        failKeyRef.current = key
        failCountRef.current = 0
      }
      setLoad({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        retryable,
        autoAttempt: retryable ? failCountRef.current + 1 : undefined,
      })
      if (retryable) {
        // Network-class failures (kernel boot/restart windows) retry with the
        // same exponential backoff the chunk loader uses, until the read lands.
        failCountRef.current += 1
        retryTimer = window.setTimeout(() => {
          if (!cancelled) setAttempt(a => a + 1)
        }, nextDelayMs(failCountRef.current))
      }
    }
    const mediaUrlOf = (): string => mediaUrl(scope, path)
    const apply = (action: EditorLoadAction): void => {
      if (cancelled) return
      switch (action.kind) {
        case 'binary':
          succeed()
          setLoad({ status: 'binary' })
          return
        case 'render':
          succeed()
          setLoad({
            status: 'ready',
            viewer: action.viewer,
            content: action.content,
            truncated: action.truncated,
            mediaUrl: action.mediaUrl,
            customData: action.customData,
          })
          return
        case 'customLoad':
          void action.viewer.load?.(path, scope, controller.signal).then((data) => {
            if (cancelled) return
            succeed()
            setLoad({ status: 'ready', viewer: action.viewer, customData: data })
          }).catch((error: unknown) => {
            if (cancelled) return
            fail(error)
          })
          return
        case 'fetchFsRead':
          api.fsRead(scope, path).then((result) => {
            if (cancelled) return
            succeed()
            // Binary reads carry the head bytes for the detect re-match.
            const outcome = planFsReadOutcome(action.viewer, {
              binary: result.kind === 'binary',
              content: result.kind === 'text' ? result.content : '',
              truncated: result.truncated,
              head: result.kind === 'binary' ? result.head : undefined,
            }, (head) => ctx.betterSidebar?.matchFileViewer(path, head), mediaUrlOf)
            apply(outcome)
          }).catch((error: unknown) => {
            if (cancelled) return
            fail(error)
          })
          return
      }
    }
    apply(planFirstMatch(ctx.betterSidebar?.matchFileViewer(path), mediaUrlOf))
    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      controller.abort()
    }
  }, [scope.sessionId, scope.cwd, path, ctx, attempt])

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <button
          type="button"
          className={css.editorBack}
          title={t('editorBack')}
          aria-label={t('editorBack')}
          onClick={goBack}
        >
          <IconChevronLeftOutline14 />
        </button>
        <span className={css.editorTitle} title={path}>{title}</span>
      </div>
      {load.status === 'loading' && <div className={css.editorPlaceholder}>{t('loading')}</div>}
      {load.status === 'error' && (
        <div className={css.editorError}>
          <span>{load.message}</span>
          {load.autoAttempt !== undefined && <span>{t('fsReadRetryWaiting', { n: load.autoAttempt })}</span>}
          <button type="button" className={css.terminalRetry} onClick={() => { setAttempt(a => a + 1) }}>
            {t('terminalRetry')}
          </button>
        </div>
      )}
      {load.status === 'binary' && <BinaryDownload scope={scope} path={path} />}
      {load.status === 'ready' && createElement(load.viewer.component, {
        ctx, store, scope, path, title,
        viewerId: load.viewer.id,
        content: load.content,
        truncated: load.truncated,
        mediaUrl: load.mediaUrl,
        customData: load.customData,
      })}
    </div>
  )
}
