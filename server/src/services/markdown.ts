import TurndownService from 'turndown'

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})

/** HTML → Markdown（插件未自带 markdown 时的兜底转换，见 design D2/D4） */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html)
}

export interface AnnotationForMarkdown {
  quote: string
  note: string | null
}

/** 在 Markdown 末尾追加"## 标注"区块：quote 以引用格式呈现 + note 笔记（specs/page-export） */
export function appendAnnotationsSection(md: string, annotations: AnnotationForMarkdown[]): string {
  if (!annotations.length) return md
  const blocks = annotations.map((a, i) => {
    const quote = a.quote
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    const note = a.note ? `\n\n笔记：${a.note}` : ''
    return `### ${i + 1}\n\n${quote}${note}`
  })
  const body = md.replace(/\s+$/, '')
  return `${body}\n\n---\n\n## 标注\n\n${blocks.join('\n\n')}\n`
}
