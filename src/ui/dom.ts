type Child = Node | string | null | undefined | false;

/** Builds an element: h('button', { class: 'go', onclick: fn }, 'Text'). Attributes starting with "on" are event listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
    else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Inline SVG from markup (used for the little icons, which are drawn in code). */
export function svg(markup: string, className = ''): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.innerHTML = markup;
  return span;
}
