const NL = String.fromCharCode(10)

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code style="background:#F1F1F4;border-radius:3px;padding:1px 4px;font-family:monospace;font-size:0.9em">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span style="color:#5D5DFF">$1</span>')
}

function tableHtml(rows) {
  const cells = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const head = cells(rows[0])
  let html = '<table style="border-collapse:collapse;margin:8px 0">'
  html += '<tr>' + head.map((c) => '<th style="border:1px solid #E4E4E7;padding:4px 8px;background:#F6F6F8;text-align:left">' + inline(c) + '</th>').join('') + '</tr>'
  for (const row of rows.slice(2)) {
    const tds = cells(row)
    html += '<tr>' + head.map((_, k) => '<td style="border:1px solid #E4E4E7;padding:4px 8px">' + inline(tds[k] ?? '') + '</td>').join('') + '</tr>'
  }
  return html + '</table>'
}

/**
 * Render markdown into segments: {type:'md', html} runs for the rich-text component,
 * plus {type:'code', text, lang} blocks the page renders inside a scroll-x scroll-view
 * (rich-text cannot scroll, so long code lines need their own element).
 */
function mdBlocks(source) {
  const lines = String(source ?? '').split(NL)
  const blocks = []
  const out = []
  let list = null
  let code = null
  let codeLang = ''
  let nid = 0
  const flushList = () => {
    if (list !== null) {
      out.push('<ul style="margin:8px 0;padding-left:20px">' + list.join('') + '</ul>')
      list = null
    }
  }
  const flushMd = () => {
    flushList()
    if (out.length > 0) {
      blocks.push({ id: ++nid, type: 'md', html: out.join('') })
      out.length = 0
    }
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim().startsWith('```')) {
      if (code === null) {
        flushMd()
        code = []
        codeLang = line.trim().slice(3).trim()
      } else {
        blocks.push({ id: ++nid, type: 'code', text: code.join(NL), lang: codeLang })
        code = null
        codeLang = ''
      }
      i++
      continue
    }
    if (code !== null) {
      code.push(line)
      i++
      continue
    }
    const t = line.trim()
    if (t.startsWith('|') && i + 1 < lines.length && /^\|?[-\s:|]+\|?$/.test(lines[i + 1].trim())) {
      const rows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].trim())
        i++
      }
      flushList()
      out.push(tableHtml(rows))
      continue
    }
    if (t.startsWith('>')) {
      const quoted = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoted.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      flushList()
      out.push('<div style="margin:8px 0;padding:2px 10px;border-left:3px solid #5D5DFF;color:#52525B">' + inline(quoted.join(' ')) + '</div>')
      continue
    }
    if (t === '') {
      flushList()
      i++
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(t)
    if (heading !== null) {
      flushList()
      const size = [40, 36, 32, 30][heading[1].length - 1]
      out.push('<div style="font-weight:700;font-size:' + size + 'rpx;margin:10px 0 6px">' + inline(heading[2]) + '</div>')
      i++
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushList()
      out.push('<hr style="border:none;border-top:1px solid #EEEEEE;margin:8px 0"/>')
      i++
      continue
    }
    const item = /^[-*+]\s+(.*)$/.exec(t) ?? /^\d+[.)]\s+(.*)$/.exec(t)
    if (item !== null) {
      if (list === null) list = []
      list.push('<li style="margin:2px 0">' + inline(item[1]) + '</li>')
      i++
      continue
    }
    flushList()
    out.push('<div style="margin:8px 0">' + inline(t) + '</div>')
    i++
  }
  flushMd()
  if (code !== null) blocks.push({ id: ++nid, type: 'code', text: code.join(NL), lang: codeLang })
  return blocks
}

module.exports = { mdBlocks }
