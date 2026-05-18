import { visit } from "unist-util-visit";

/**
 * Replaces ```mermaid code blocks with <div class="mermaid-source"> wrappers
 * that hold the raw diagram source in a data attribute. A client-side script
 * (MermaidRunner) hydrates these into rendered SVG after the page loads.
 *
 * We deliberately do build-time HTML wrap (not playwright/SVG generation) to
 * keep the build dependency surface small.
 */
export default function remarkMermaid() {
  return (tree) => {
    visit(tree, "code", (node, index, parent) => {
      if (!parent || index == null) return;
      if (node.lang !== "mermaid") return;
      parent.children[index] = {
        type: "html",
        value:
          `<figure class="mermaid-figure"><div class="mermaid-source" data-source="${encodeURIComponent(node.value)}">` +
          `<pre class="mermaid-fallback"><code>${escapeHtml(node.value)}</code></pre>` +
          `</div></figure>`,
      };
    });
  };
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
