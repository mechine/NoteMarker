// 文本锚点与 DOM 包裹工具（specs/extension-highlighter，design D6/D7）：
// 生成与恢复共用同一"页面全文文本模型"（body 文本节点顺序拼接），
// 保证 quote/prefix/suffix 一定是该模型的子串，恢复时可直接定位。

export interface TextIndex {
  text: string
  /** 文本节点 → 在全文中的起始偏移 */
  starts: Map<Text, number>
  /** 按序文本节点（与 starts 配套，二分定位用） */
  nodes: Text[]
}

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'CANVAS',
  'SVG',
  // 批注编号标签（specs/annotation-numbering）：其文本是"编号+批注"，混入全文会污染锚点
  'NOTEMARKER-NOTE',
])

function skippable(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true
  // 排除扩展自身 UI（toast 容器在 body 内、划线 UI 与截图遮罩在 documentElement 上）
  return (
    el.id === 'notemarker-extension-root' ||
    el.id === 'notemarker-highlighter-root' ||
    el.id === 'notemarker-shot-mask'
  )
}

/** 遍历 body 文本节点构建全文索引；文本节点拆分/包裹后需重建（调用方维护 dirty 标记） */
export function buildTextIndex(root: Element): TextIndex {
  const chunks: string[] = []
  const starts = new Map<Text, number>()
  const nodes: Text[] = []
  let pos = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement
      if (parent && skippable(parent)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let n: Node | null
  while ((n = walker.nextNode())) {
    const t = n as Text
    // 纯空白文本节点对锚点无贡献且浪费索引
    if (!t.data) continue
    starts.set(t, pos)
    nodes.push(t)
    chunks.push(t.data)
    pos += t.data.length
  }
  return { text: chunks.join(''), starts, nodes }
}

/** 选区 Range → 全文偏移；startContainer 非 Text（如元素直接选区）时返回 null 由调用方降级 */
export function rangeToOffsets(index: TextIndex, range: Range): { start: number; end: number } | null {
  const { startContainer, endContainer, startOffset, endOffset } = range
  if (startContainer.nodeType !== Node.TEXT_NODE || endContainer.nodeType !== Node.TEXT_NODE) {
    return null
  }
  const s = index.starts.get(startContainer as Text)
  const e = index.starts.get(endContainer as Text)
  if (s === undefined || e === undefined) return null
  return { start: s + startOffset, end: e + endOffset }
}

/** 全文偏移 → 所在文本节点（二分：最后一个起始偏移 <= offset 的节点） */
function nodeFor(index: TextIndex, offset: number): { node: Text; nodeStart: number } | null {
  const { nodes, starts } = index
  let lo = 0
  let hi = nodes.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((starts.get(nodes[mid]) ?? 0) <= offset) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (ans === -1) return null
  return { node: nodes[ans], nodeStart: starts.get(nodes[ans]) ?? 0 }
}

/** 全文偏移 → Range（start/end 各二分一次；end 用 end-1 定位保证落在节点内） */
export function offsetsToRange(index: TextIndex, start: number, end: number): Range | null {
  if (start < 0 || end > index.text.length || start >= end) return null
  const s = nodeFor(index, start)
  const e = nodeFor(index, end - 1)
  if (!s || !e) return null
  const range = document.createRange()
  try {
    range.setStart(s.node, start - s.nodeStart)
    range.setEnd(e.node, end - e.nodeStart)
    return range
  } catch {
    return null
  }
}

/**
 * 按锚点在全文中定位 quote：优先 prefix+quote+suffix 全锚点匹配，失配降级 quote-only。
 * 返回 quote 的全文偏移；找不到返回 null（调用方静默跳过该条）。
 */
export function findByQuote(
  index: TextIndex,
  quote: string,
  prefix?: string | null,
  suffix?: string | null,
): { start: number; end: number } | null {
  if (!quote) return null
  const t = index.text
  if (prefix) {
    const probe = prefix + quote
    let from = 0
    for (;;) {
      const i = t.indexOf(probe, from)
      if (i === -1) break
      const end = i + probe.length
      if (!suffix || t.slice(end, end + suffix.length) === suffix) {
        return { start: i + prefix.length, end }
      }
      from = i + 1
    }
  }
  const j = t.indexOf(quote)
  if (j === -1) return null
  return { start: j, end: j + quote.length }
}

/**
 * 把 Range 内的文本逐节点包进 <notemarker-hl data-id data-type data-color>。
 * 跨标签选区天然拆分为多个包裹元素；已被其他划线包裹的节点跳过（重叠保护）。
 * 返回创建的包裹元素（空数组表示无可包裹文本）。
 */
export function wrapRange(range: Range, id: string, type: string, color: string): HTMLElement[] {
  const targets: Array<{ node: Text; start: number; end: number }> = []
  // commonAncestor 为 Text（单文本节点选区）时 walker 以其为根会漏访，提升到父元素
  const walkRoot =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? (range.commonAncestorContainer.parentElement ?? range.commonAncestorContainer)
      : range.commonAncestorContainer
  const walker = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT)
  let n: Node | null
  while ((n = walker.nextNode())) {
    const t = n as Text
    // 节点与选区相交：节点起点不晚于选区终点，且节点终点不早于选区起点（部分重叠的边界节点要保留）
    if (range.comparePoint(t, 0) > 0) continue
    if (range.comparePoint(t, t.length) < 0) continue
    const start = t === range.startContainer ? range.startOffset : 0
    const end = t === range.endContainer ? range.endOffset : t.length
    if (end > start) targets.push({ node: t, start, end })
  }

  const wrapped: HTMLElement[] = []
  for (const { node, start, end } of targets) {
    let target = node
    let innerEnd = end
    if (start > 0) {
      // splitText(start)：原节点保留 [0,start)，返回的尾节点含 [start,)
      target = node.splitText(start)
      innerEnd -= start
    }
    if (innerEnd < target.length) {
      target.splitText(innerEnd)
    }
    // 重叠保护：已被其他划线包裹的文本不再包第二层
    if (target.parentElement?.closest('notemarker-hl')) continue
    const host = target.parentElement
    if (!host) continue
    const wrap = document.createElement('notemarker-hl')
    wrap.setAttribute('data-id', id)
    wrap.setAttribute('data-type', type)
    wrap.setAttribute('data-color', color)
    host.insertBefore(wrap, target)
    wrap.appendChild(target)
    wrapped.push(wrap)
  }
  return wrapped
}

/** 拆除某条划线的全部包裹元素（文本回归原位） */
export function unwrapById(id: string): void {
  document.querySelectorAll(`notemarker-hl[data-id="${CSS.escape(id)}"]`).forEach((el) => {
    const parent = el.parentNode
    if (!parent) return
    while (el.firstChild) parent.insertBefore(el.firstChild, el)
    el.remove()
    parent.normalize()
  })
}

/** 换色/切换下划线：更新该条全部包裹元素（及图片标注）的样式属性 */
export function restyleWrappers(id: string, type: string, color: string): void {
  document.querySelectorAll(`notemarker-hl[data-id="${CSS.escape(id)}"]`).forEach((el) => {
    el.setAttribute('data-type', type)
    el.setAttribute('data-color', color)
  })
  // 图片标注（specs image-annotation）：改描边色
  document.querySelectorAll(`img[data-notemarker-id="${CSS.escape(id)}"]`).forEach((el) => {
    el.setAttribute('data-notemarker-color', color)
  })
}
