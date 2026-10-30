// DOM helpers. Everything user- or resume-derived is inserted with textContent / text nodes, never innerHTML.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function") node.addEventListener(key.replace(/^on/, ""), value);
    else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

export function $(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function say(target: HTMLElement, text: string, kind: "ok" | "error" | "info" = "info"): void {
  target.textContent = text;
  target.dataset.kind = kind;
}
