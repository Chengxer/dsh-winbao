/**
 * @dsh-external/dsh-searxng-web-search — 本地 SearXNG web 搜索提供方。
 *
 * 向 ctx.web 注册 id 为 "searxng" 的 WebSearchProvider：把 web_search 的查询
 * 转发到本机 SearXNG 的 JSON 接口（默认 http://127.0.0.1:8888），并把 results[]
 * 归一化为 WebSearchSource { url, title, snippet, publishedAt }。
 *
 * 传输方式：优先使用 Node 全局 fetch（profile 插件运行在完整 Node 环境），
 * 不可用时回退到 ctx.shell + curl（Linux/Windows 均带 curl）。
 *
 * 选择：正常路径由启动脚本里的 $DSH_WEB_SEARCH_PROVIDER=searxng 在 WebRuntime
 * 构造时指定；这里再做一次防御性覆盖（不改变既有配置时），避免与 deepseek
 * provider（其 available() 恒真）并存时出现歧义。插件卸载时还原。
 */
export default {
  name: 'dsh-searxng-web-search',
  inject: ['web'],
  apply(ctx) {
    const shell = ctx.get('shell')
    const useFetch = typeof fetch === 'function'

    const baseURL = 'http://127.0.0.1:8888'
    const language = 'zh'
    const categories = 'general,news'

    function buildUrl(query) {
      return baseURL + '/search?q=' + encodeURIComponent(query) +
        '&format=json' +
        '&language=' + encodeURIComponent(language) +
        '&categories=' + encodeURIComponent(categories)
    }

    async function fetchText(url, signal) {
      if (useFetch) {
        const res = await fetch(url, { signal })
        if (!res.ok) throw new Error('searxng request failed (HTTP ' + res.status + ')')
        return await res.text()
      }
      if (shell === undefined) throw new Error('no http transport available (fetch missing and no shell)')
      const spec = shell.resolve({
        command: 'curl -sS -m 30 ' + JSON.stringify(url),
        timeoutMs: 40000,
        stdoutMaxBytes: 4 * 1024 * 1024,
        signal,
      })
      const result = await shell.run(spec)
      if (result.exitCode !== 0) {
        throw new Error('searxng request failed (exit ' + result.exitCode + '): ' + result.stderr.text)
      }
      return result.stdout.text
    }

    ctx.web.registerSearchProvider({
      id: 'searxng',
      available() {
        return true
      },
      async search(request, signal) {
        let data
        try {
          data = JSON.parse(await fetchText(buildUrl(request.query), signal))
        } catch (e) {
          throw new Error('searxng search failed: ' + (e && e.message ? e.message : String(e)))
        }
        const sources = (data.results || []).map((r) => {
          const source = { url: String(r.url || '') }
          if (r.title) source.title = String(r.title)
          if (r.content) source.snippet = String(r.content)
          if (r.publishedDate) source.publishedAt = String(r.publishedDate)
          return source
        })
        return { sources, truncated: false }
      },
    })

    // 防御性选择覆盖（可逆）
    ctx.effect(() => {
      const prev = ctx.web.searchProviderId
      if (prev !== 'searxng') ctx.web.searchProviderId = 'searxng'
      return () => {
        if (ctx.web.searchProviderId === 'searxng') ctx.web.searchProviderId = prev
      }
    })

    console.log('[dsh-searxng-web-search] registered searxng provider (transport: ' + (useFetch ? 'fetch' : 'shell+curl') + ')')
  },
}
