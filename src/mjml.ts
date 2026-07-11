// ============================================================
// Minimal MJML → HTML compiler.
//
// The EDM render pipeline mirrors the legacy app: a Liquid template emits MJML,
// which is then compiled to email-safe, table-based HTML. The real `mjml`
// package is a large Node-only dependency (filesystem component loading, a big
// transitive tree) that doesn't fit a Workers plugin, so we compile the small
// MJML subset our templates use ourselves — the same self-contained approach as
// the QR encoder.
//
// Supported: mj-head (mj-attributes defaults + mj-class, mj-style, mj-preview,
// mj-raw), mj-body, mj-section, mj-column, mj-text, mj-image, mj-button,
// mj-table. Attribute precedence follows MJML: element > mj-class > mj-attributes
// type default > component default.
// ============================================================

interface MjmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: MjmlNode[];
  /** Verbatim inner HTML for content tags (mj-text, mj-button, mj-table, …). */
  raw?: string;
}

/** Tags whose inner content is raw HTML, not nested MJML. */
const RAW_TAGS = new Set(['mj-text', 'mj-button', 'mj-table', 'mj-style', 'mj-preview', 'mj-raw']);

/** Component defaults (lowest precedence), overridden by the head and elements. */
const COMPONENT_DEFAULTS: Record<string, Record<string, string>> = {
  'mj-section': { padding: '20px 0' },
  'mj-text': { padding: '10px 25px', 'font-size': '14px', 'line-height': '1.5', color: '#000000', align: 'left' },
  'mj-image': { padding: '10px 25px', align: 'center' },
  'mj-button': {
    padding: '10px 25px', 'inner-padding': '10px 25px', 'background-color': '#414141',
    color: '#ffffff', 'border-radius': '3px', align: 'center', 'font-size': '13px',
  },
  'mj-table': { padding: '10px 25px', 'font-size': '13px', 'line-height': '22px', color: '#000000' },
};

// ── Parser ────────────────────────────────────────────────────────────────────
function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) attrs[m[1]] = m[2];
  return attrs;
}

/** Parses an MJML string into a node tree (content tags keep raw inner HTML). */
export function parseMjml(input: string): MjmlNode {
  const root: MjmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack: MjmlNode[] = [root];
  let i = 0;
  const src = input;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    // Skip comments.
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    const gt = src.indexOf('>', lt);
    if (gt === -1) break;
    const inner = src.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (inner.startsWith('/')) {
      // Close tag.
      const name = inner.slice(1).trim().toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const tag = (space === -1 ? body : body.slice(0, space)).toLowerCase();
    const attrs = space === -1 ? {} : parseAttrs(body.slice(space));
    const node: MjmlNode = { tag, attrs, children: [] };

    if (!tag.startsWith('mj-') && tag !== 'mjml') {
      // Stray non-MJML markup at the structural level — ignore.
      continue;
    }

    stack[stack.length - 1].children.push(node);
    if (selfClosing) continue;

    if (RAW_TAGS.has(tag)) {
      // Capture inner HTML verbatim up to the matching close tag.
      const close = `</${tag}>`;
      const end = src.indexOf(close, i);
      node.raw = (end === -1 ? src.slice(i) : src.slice(i, end)).trim();
      i = end === -1 ? src.length : end + close.length;
      continue;
    }
    stack.push(node);
  }
  return root;
}

// ── Head processing ───────────────────────────────────────────────────────────
interface Head {
  typeDefaults: Record<string, Record<string, string>>;
  classes: Record<string, Record<string, string>>;
  styles: string[];
  raw: string[];
  preview: string;
}

function collectHead(root: MjmlNode): Head {
  const head: Head = { typeDefaults: {}, classes: {}, styles: [], raw: [], preview: '' };
  const headNode = find(root, 'mj-head');
  if (!headNode) return head;
  for (const child of headNode.children) {
    if (child.tag === 'mj-attributes') {
      for (const attr of child.children) {
        if (attr.tag === 'mj-class') {
          const { name, ...rest } = attr.attrs;
          if (name) head.classes[name] = rest;
        } else {
          head.typeDefaults[attr.tag] = { ...(head.typeDefaults[attr.tag] ?? {}), ...attr.attrs };
        }
      }
    } else if (child.tag === 'mj-style' && child.raw) {
      head.styles.push(child.raw);
    } else if (child.tag === 'mj-raw' && child.raw) {
      head.raw.push(child.raw);
    } else if (child.tag === 'mj-preview' && child.raw) {
      head.preview = child.raw;
    }
  }
  return head;
}

function find(node: MjmlNode, tag: string): MjmlNode | undefined {
  for (const child of node.children) {
    if (child.tag === tag) return child;
    const nested = find(child, tag);
    if (nested) return nested;
  }
  return undefined;
}

/** Resolves a node's effective attributes by MJML precedence. */
function resolve(node: MjmlNode, head: Head): Record<string, string> {
  const classAttrs: Record<string, string> = {};
  for (const name of (node.attrs['mj-class'] ?? '').split(/\s+/).filter(Boolean)) {
    Object.assign(classAttrs, head.classes[name] ?? {});
  }
  return {
    ...(COMPONENT_DEFAULTS[node.tag] ?? {}),
    ...(head.typeDefaults[node.tag] ?? {}),
    ...classAttrs,
    ...node.attrs,
  };
}

// ── HTML rendering ─────────────────────────────────────────────────────────────
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function style(pairs: Array<[string, string | undefined]>): string {
  const parts = pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}:${v}`);
  return parts.length ? ` style="${parts.join(';')}"` : '';
}

function renderText(node: MjmlNode, head: Head): string {
  const a = resolve(node, head);
  return `<div${style([
    ['font-family', a['font-family']], ['font-size', a['font-size']], ['line-height', a['line-height']],
    ['color', a.color], ['text-align', a.align], ['padding', a.padding],
  ])}>${node.raw ?? ''}</div>`;
}

function renderImage(node: MjmlNode, head: Head): string {
  const a = resolve(node, head);
  const img = `<img src="${esc(a.src ?? '')}"${a.width ? ` width="${esc(a.width)}"` : ''}` +
    `${style([['display', 'block'], ['width', a.width ? `${a.width}` : '100%'], ['max-width', '100%'], ['height', 'auto'], ['border', '0']])} />`;
  const image = a.href ? `<a href="${esc(a.href)}" style="display:inline-block">${img}</a>` : img;
  return `<div${style([['padding', a.padding], ['text-align', a.align]])}>${image}</div>`;
}

function renderButton(node: MjmlNode, head: Head): string {
  const a = resolve(node, head);
  const link = `<a href="${esc(a.href ?? '#')}"${style([
    ['display', 'inline-block'], ['background-color', a['background-color']], ['color', a.color],
    ['border-radius', a['border-radius']], ['padding', a['inner-padding']], ['font-size', a['font-size']],
    ['font-family', a['font-family'] ?? head.typeDefaults['mj-text']?.['font-family']],
    ['text-decoration', 'none'], ['font-weight', 'bold'],
  ])}>${node.raw ?? ''}</a>`;
  return `<div${style([['padding', a.padding], ['text-align', a.align]])}>${link}</div>`;
}

function renderTable(node: MjmlNode, head: Head): string {
  const a = resolve(node, head);
  return `<div${style([['padding', a.padding]])}>` +
    `<table cellpadding="0" cellspacing="0" width="100%"${style([
      ['font-family', a['font-family']], ['font-size', a['font-size']], ['line-height', a['line-height']],
      ['color', a.color], ['width', '100%'], ['border-collapse', 'collapse'],
    ])}>${node.raw ?? ''}</table></div>`;
}

function renderColumnChild(node: MjmlNode, head: Head): string {
  switch (node.tag) {
    case 'mj-text': return renderText(node, head);
    case 'mj-image': return renderImage(node, head);
    case 'mj-button': return renderButton(node, head);
    case 'mj-table': return renderTable(node, head);
    case 'mj-raw': return node.raw ?? '';
    default: return '';
  }
}

function renderSection(node: MjmlNode, head: Head, width: number): string {
  const a = resolve(node, head);
  const columns = node.children.filter((c) => c.tag === 'mj-column');
  const cells = columns.map((col) => {
    const body = col.children.map((child) => renderColumnChild(child, head)).join('');
    return `<td valign="top"${style([['vertical-align', 'top']])}>${body}</td>`;
  }).join('');
  return `<table align="center" cellpadding="0" cellspacing="0" role="presentation" width="${width}"` +
    `${style([['width', `${width}px`], ['max-width', `${width}px`], ['margin', '0 auto'], ['background-color', a['background-color']]])}>` +
    `<tr><td${style([['padding', a.padding]])}><table cellpadding="0" cellspacing="0" width="100%"><tr>${cells}</tr></table></td></tr></table>`;
}

/** Compiles an MJML document to a full HTML email. */
export function mjmlToHtml(mjml: string): string {
  const root = parseMjml(mjml);
  const head = collectHead(root);
  const bodyNode = find(root, 'mj-body');
  const bodyAttrs = bodyNode ? resolve(bodyNode, head) : {};
  const width = Number.parseInt(bodyAttrs.width ?? '600', 10) || 600;
  const bg = bodyAttrs['background-color'] ?? '#ffffff';

  const sections = (bodyNode?.children ?? [])
    .filter((c) => c.tag === 'mj-section')
    .map((section) => renderSection(section, head, width))
    .join('');

  const styleTag = head.styles.length ? `<style type="text/css">${head.styles.join('\n')}</style>` : '';
  const rawHead = head.raw.join('\n');
  const preview = head.preview
    ? `<div style="display:none;max-height:0;overflow:hidden">${esc(head.preview)}</div>`
    : '';

  return '<!doctype html>' +
    '<html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="X-UA-Compatible" content="IE=edge">' +
    `${rawHead}${styleTag}</head>` +
    `<body style="margin:0;padding:0;background-color:${esc(bg === '#ffffff' ? '#f4f4f4' : bg)}">` +
    `${preview}` +
    `<table cellpadding="0" cellspacing="0" width="100%" style="background-color:${esc(bg === '#ffffff' ? '#f4f4f4' : bg)}"><tr>` +
    `<td align="center" style="padding:0">${sections}</td></tr></table>` +
    '</body></html>';
}
