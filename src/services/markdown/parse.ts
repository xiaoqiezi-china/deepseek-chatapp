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

/** 预处理时插在闭合 ** 后的标记：发丝空格让 CommonMark 将其识别为右边界，解析后再移除。 */
const BOLD_SENTINEL = '\u200A\uE001'
const PUNCTUATION = /[\p{P}\p{S}]/u
const WHITESPACE = /\s/u

/** 货币金额里的 $ 会被单美元数学语法误判为公式定界符，解析前先替换成占位符。 */
const CURRENCY = '\uE000'
const MONEY = /\d[\d,]*\.\d{2}/

/**
 * CommonMark 要求 ** 的右边界前不能是空白，后不能是非标点。中文句号后的
 * ** 直接接汉字时会被判成左边界，结果它会和后面的 ** 配对，外层 A/C 的
 * 两个 ** 反而留在文本里。这里只给“中文标点后的闭合 **”补一个临时空格，
 * 让解析器按右边界处理；该空格和标记在解析后由 simplify 清掉。
 */
const prepareBoldClosers = (input: string): string => {
  const inserts: number[] = []
  let open = false
  let fenced = false
  let fence = ''
  let offset = 0

  for (const line of input.split(/(?<=\n)/)) {
    const trimmed = line.trimStart()
    const marker = trimmed.match(/^(```+|~~~+)/)?.[0]
    if (marker) {
      if (!fenced) {
        fenced = true
        fence = marker[0]
      } else if (marker[0] === fence) {
        fenced = false
      }
      offset += line.length
      continue
    }
    if (fenced) {
      offset += line.length
      continue
    }
    if (trimmed === '') {
      open = false
      offset += line.length
      continue
    }

    let index = 0
    while (index < line.length) {
      if (line[index] === '`') {
        let ticks = 1
        while (line[index + ticks] === '`') {
          ticks += 1
        }
        const close = line.indexOf('`'.repeat(ticks), index + ticks)
        if (close !== -1) {
          index = close + ticks
          continue
        }
      }
      if (
        line[index] === '*' &&
        line[index + 1] === '*' &&
        line[index + 2] !== '*' &&
        line[index - 1] !== '*'
      ) {
        let slashes = 0
        for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
          slashes += 1
        }
        if (slashes % 2 === 0) {
          if (open) {
            const start = offset + index
            const end = start + 2
            const before = [...input.slice(0, start)].at(-1) ?? ''
            const after = [...input.slice(end, end + 2)][0] ?? ''
            if (
              PUNCTUATION.test(before) &&
              !WHITESPACE.test(after) &&
              !PUNCTUATION.test(after)
            ) {
              inserts.push(end)
            }
            open = false
          } else {
            open = true
          }
          index += 2
          continue
        }
      }
      index += 1
    }
    offset += line.length
  }

  if (inserts.length === 0) {
    return input
  }
  let output = input
  for (const at of inserts.sort((left, right) => right - left)) {
    output = output.slice(0, at) + BOLD_SENTINEL + output.slice(at)
  }
  return output
}

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
  const prepared = prepareBoldClosers(escapeCurrency(input))
  const ast = fromMarkdown(prepared, {
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
  const raw = (node: Nodes) =>
    prepared.slice(node.position?.start.offset, node.position?.end.offset)
  // 先处理子节点，再按需把当前节点换成若干节点
  const simplify = (node: Nodes): Nodes[] => {
    if (node.type === 'text') {
      const value = node.value.split(BOLD_SENTINEL).join('')
      if (value !== node.value) {
        node.value = value
      }
      // 跳过被转义的星号，避免把 \*\*...\*\* 当成加粗
      if (!(node.position && raw(node).includes('\\*'))) {
        const parts = splitBold(value)
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
