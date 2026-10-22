import { getLab, listLabs, startSession, stopSession, type LabDetail } from './api';
import { renderStep } from './instructions';
import { LabTerminal } from './terminal';
import './style.css';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const statusEl = $<HTMLSpanElement>('#status');
const stopBtn = $<HTMLButtonElement>('#stop');
const catalogEl = $<HTMLElement>('#catalog');
const labEl = $<HTMLElement>('#lab');
const labTitleEl = $<HTMLElement>('#lab-title');
const stepEl = $<HTMLElement>('#step');
const stepCounterEl = $<HTMLSpanElement>('#step-counter');
const prevBtn = $<HTMLButtonElement>('#prev');
const nextBtn = $<HTMLButtonElement>('#next');

const setStatus = (text: string) => (statusEl.textContent = text);
const terminal = new LabTerminal($('#terminal'), setStatus);

let lab: LabDetail | null = null;
let stepIndex = 0;
let sessionId: string | null = null;

// --- catalog view ---------------------------------------------------------

async function showCatalog() {
  labEl.hidden = true;
  catalogEl.hidden = false;
  stopBtn.hidden = true;
  labTitleEl.textContent = '';
  setStatus('');

  catalogEl.replaceChildren();
  for (const summary of await listLabs()) {
    const card = document.createElement('button');
    card.className = 'card';
    card.innerHTML = `
      <span class="meta"></span>
      <strong></strong>
      <p></p>`;
    card.querySelector('.meta')!.textContent =
      `${summary.difficulty} · ${summary.stepCount} steps · ${summary.ttlMinutes} min`;
    card.querySelector('strong')!.textContent = summary.title;
    card.querySelector('p')!.textContent = summary.description;
    card.onclick = () => openLab(summary.slug);
    catalogEl.append(card);
  }
}

// --- lab view -------------------------------------------------------------

async function openLab(slug: string) {
  lab = await getLab(slug);
  stepIndex = 0;
  catalogEl.hidden = true;
  labEl.hidden = false;
  labTitleEl.textContent = lab.title;
  showStep();
  terminal.fit();

  // Users can start reading while the container boots.
  setStatus('Starting lab…');
  try {
    sessionId = (await startSession(slug)).id;
    stopBtn.hidden = false;
    terminal.connect(sessionId);
  } catch (err) {
    setStatus(`Failed to start: ${(err as Error).message}`);
    stopBtn.hidden = false; // doubles as "back to catalog"
  }
}

function showStep() {
  if (!lab) return;
  renderStep(stepEl, lab.steps[stepIndex].markdown, (cmd) => terminal.run(cmd));
  stepEl.scrollTop = 0;
  stepCounterEl.textContent = `Step ${stepIndex + 1} of ${lab.steps.length}`;
  prevBtn.disabled = stepIndex === 0;
  nextBtn.disabled = stepIndex === lab.steps.length - 1;
}

prevBtn.onclick = () => {
  stepIndex--;
  showStep();
};
nextBtn.onclick = () => {
  stepIndex++;
  showStep();
};

stopBtn.onclick = async () => {
  stopBtn.disabled = true;
  terminal.disconnect();
  if (sessionId) {
    setStatus('Stopping…');
    await stopSession(sessionId).catch(() => {});
    sessionId = null;
  }
  stopBtn.disabled = false;
  await showCatalog();
};

showCatalog().catch((err) => setStatus(`Failed to load labs: ${(err as Error).message}`));
