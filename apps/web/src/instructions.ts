import DOMPurify from 'dompurify';
import { marked } from 'marked';

const RUNNABLE = new Set(['bash', 'sh', 'shell']);

/**
 * Renders a step's Markdown into `el`. Code blocks marked as bash/sh get a Run button;
 * other code blocks (file contents, sample output) stay inert.
 */
export function renderStep(el: HTMLElement, markdown: string, onRun: (command: string) => void) {
  // Sanitize even though labs are "ours": once outside authors can publish labs,
  // lab content is untrusted input rendered inside the app's origin.
  el.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { async: false }));

  for (const code of el.querySelectorAll<HTMLElement>('pre > code')) {
    const lang = [...code.classList].find((c) => c.startsWith('language-'))?.slice('language-'.length);
    if (!lang || !RUNNABLE.has(lang)) continue;

    const button = document.createElement('button');
    button.className = 'run';
    button.textContent = 'Run';
    button.onclick = () => onRun(code.textContent ?? '');
    code.parentElement!.append(button);
  }
}
