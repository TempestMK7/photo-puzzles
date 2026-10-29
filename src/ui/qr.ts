/** The dark squares of a QR code for `text`, row by row. The library is loaded when a code is first asked for: most players never need it. */
export async function qrMatrix(text: string): Promise<boolean[][]> {
  const { default: qrcode } = await import('qrcode-generator');
  const code = qrcode(0, 'M');                                // the smallest version that fits, with some room for a smudge
  code.addData(text);
  code.make();
  const n = code.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => code.isDark(r, c)));
}

/** The squares as one SVG path (a run of dark squares in a row is one rectangle). */
export function qrPath(modules: boolean[][], margin = 4): string {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < row.length && row[end + 1]) end++;
      parts.push(`M${x + margin} ${y + margin}h${end - x + 1}v1h${x - end - 1}z`);
      x = end;
    }
  });
  return parts.join('');
}

/** A QR code as an element: always black on white with the quiet zone around it, whatever the colours of the page, because that is what scanners read. */
export async function qrSvg(text: string, label: string): Promise<SVGSVGElement> {
  const modules = await qrMatrix(text);
  const margin = 4;
  const size = modules.length + margin * 2;
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg');
  el.setAttribute('viewBox', `0 0 ${size} ${size}`);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  el.setAttribute('shape-rendering', 'crispEdges');
  const back = document.createElementNS(ns, 'rect');
  back.setAttribute('width', String(size));
  back.setAttribute('height', String(size));
  back.setAttribute('fill', '#fff');
  const dark = document.createElementNS(ns, 'path');
  dark.setAttribute('d', qrPath(modules, margin));
  dark.setAttribute('fill', '#000');
  el.append(back, dark);
  return el;
}
