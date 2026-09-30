// i18n 工具（specs extension-i18n design D3/D4）：
// t() 取词——chrome.i18n 自动按浏览器语言匹配并回落 default_locale(en)，
// 仍取不到时返回 key 本身并告警（缺键可定位，不渲染空串）；
// hydrate() 按 data-i18n / data-i18n-attr 标注把静态文案注入 DOM。

export function t(key: string, substitutions?: string[]): string {
  const s = chrome.i18n.getMessage(key, substitutions)
  if (s) return s
  console.warn(`[notemarker/i18n] missing message key: ${key}`)
  return key
}

/** data-i18n="key" 写 textContent；data-i18n-attr="attr:key attr2:key2" 写属性（placeholder/title 等） */
export function hydrate(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    if (key) el.textContent = t(key)
  })
  root.querySelectorAll<HTMLElement>('[data-i18n-attr]').forEach((el) => {
    const spec = el.getAttribute('data-i18n-attr') ?? ''
    for (const pair of spec.split(/\s+/)) {
      const idx = pair.indexOf(':')
      if (idx <= 0) continue
      el.setAttribute(pair.slice(0, idx), t(pair.slice(idx + 1)))
    }
  })
}
