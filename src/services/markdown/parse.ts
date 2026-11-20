import type { Node as MdAstNode, Nodes, Parent, RootContent, Root, Text } from 'mdast'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-llm-math'
import type { Source } from '../chat/view.js'

/** 正文里的 [citation:N]，已换成对应来源 */
export interface CitationNode extends MdAstNode {
  type: 'citation'
  source: Source
}

declare module 'mdast' {
  interface RootContentMap {
    citation: CitationNode
  }

  interface PhrasingContentMap {
    citation: CitationNode
  }
}

const text = (value: string): Text => ({ type: 'text', value })

/** 货币金额里的 $ 会被单美元数学语法误判为公式定界符，解析前先替换成占位符。 */
const CURRENCY = '\uE000'
const MONEY = /\d[\d,]*\.\d{2}/

const escapeCurrency = (input: string): string => {
  const lines = input.split('\n')
  return lines
    .map((line) => {
      let output = ''
      let index = 0
      while (index < line.length) {
        const char = line[index]
        if (char !== '$' || (index > 0 && line[index - 1] === '\\')) {
          output += char
          index += 1
          continue
        }
        if (line[index + 1] === '$') {
          output += '$$'
          index += 2
          continue
        }
        let end = index + 1
        while (end < line.length) {
          if (line[end] === '$' && line[end - 1] !== '\\' && line[end + 1] !== '$') {
            break
          }
          end += 1
        }
        if (end >= line.length) {
          output += line.slice(index)
          break
        }
        const content = line.slice(index + 1, end)
        // 含加粗标记或两位小数的金额不可能是行内公式，按普通文本保留。
        output +=
          content.includes('**') || MONEY.test(content)
            ? CURRENCY + content + CURRENCY
            : line.slice(index, end + 1)
        index = end + 1
      }
      return output
    })
    .join('\n')
}

const restoreCurrency = (node: Nodes): void => {
  const record = node as Nodes & { value?: unknown; children?: Nodes[] }
  if (typeof record.value === 'string') {
    record.value = record.value.split(CURRENCY).join('$')
  }
  record.children?.forEach(restoreCurrency)
}

const BOLD = /(?<!\\)\*\*([^\n]+?)(?<!\\)\*\*/g

/**
 * CommonMark 的闭合 ** 紧跟在“。”等标点后、又直接接中文时，会被判定为左边界，
 * 导致整段保留星号。把解析器未能识别的 **...** 兜底换成 strong。
 */
const splitBold = (value: string): Nodes[] | null => {
  const nodes: Nodes[] = []
  let last = 0
  for (const match of value.matchAll(BOLD)) {
    const index = match.index ?? 0
    if (index > last) {
      nodes.push(text(value.slice(last, index)))
    }
    nodes.push({ type: 'strong', children: [text(match[1])] })
    last = index + match[0].length
  }
  if (nodes.length === 0) {
    return null
  }
  if (last < value.length) {
    nodes.push(text(value.slice(last)))
  }
  return nodes
}

/**
 * 解析正文，并把渲染器不单独处理的节点提前换掉，渲染时无需再读原文：
 * - 传入 sources 时，[citation:N] 换成角标节点，找不到来源的直接去掉
 * - disableLink 时链接只保留文字
 * - 删除线保留原样的 ~ 定界符，脚注、引用式链接与定义显示原文
 */
export function toMdAst(
  input: string,
  { sources, disableLink }: { sources: Source[] | undefined; disableLink: boolean }
): Root {
  const ast = fromMarkdown(escapeCurrency(input), {
    extensions: [
      // codeIndented 语法导致有前导空格的列表无法正常渲染
      { ...gfm(), disable: { null: ['codeIndented'] } },
      math({ singleDollarTextMath: true }),
    ],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
  if (sources) {
    const sourcesByIndex = new Map(sources.map((source) => [source.index, source]))
    findAndReplace(
      ast,
      [
        /\[citation:(\d+)\]/g,
        (_: string, index: string): CitationNode | '' => {
          const source = sourcesByIndex.get(Number(index))
          return source ? { type: 'citation', source } : ''
        },
      ],
      { ignore: ['linkReference'] }
    )
  }
  const raw = (node: Nodes) => input.slice(node.position?.start.offset, node.position?.end.offset)
  // 先处理子节点，再按需把当前节点换成若干节点
  const simplify = (node: Nodes): Nodes[] => {
    if (node.type === 'text') {
      // 跳过被转义的星号，避免把 \*\*...\*\* 当成加粗
      if (!(node.position && raw(node).includes('\\*'))) {
        const parts = splitBold(node.value)
        if (parts) {
          return parts
        }
      }
      return [node]
    }
    if ('children' in node) {
      ;(node as Parent).children = node.children.flatMap(simplify) as RootContent[]
    }
    switch (node.type) {
      case 'link':
        return disableLink ? node.children : [node]
      case 'delete': {
        // 解析器保证首尾定界符等长
        const delimiter = raw(node).match(/^~+/)?.[0] ?? ''
        return [text(delimiter), ...node.children, text(delimiter)]
      }
      case 'footnoteReference':
      case 'imageReference':
      case 'linkReference':
        return [text(raw(node))]
      case 'footnoteDefinition':
      case 'definition':
        return [{ type: 'paragraph', children: [text(raw(node))] }]
      default:
        return [node]
    }
  }
  simplify(ast)
  restoreCurrency(ast)
  return ast
}
