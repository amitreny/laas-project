import {
  extendSession,
  getSession,
  getLab,
  listLabs,
  startSession,
  stopSession,
  type LabDetail,
  type Session,
} from './api';
import { renderStep } from './instructions';
import { LabTerminal } from './terminal';
import './style.css';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const statusEl = $<HTMLSpanElement>('#status');
const timerEl = $<HTMLSpanElement>('#timer');
const extendBtn = $<HTMLButtonElement>('#extend');
const stopBtn = $<HTMLButtonElement>('#stop');
const catalogEl = $<HTMLElement>('#catalog');
const labEl = $<HTMLElement>('#lab');
const labTitleEl = $<HTMLElement>('#lab-title');
const stepEl = $<HTMLElement>('#step');
const stepCounterEl = $<HTMLSpanElement>('#step-counter');
const prevBtn = $<HTMLButtonElement>('#prev');
const nextBtn = $<HTMLButtonElement>('#next');

const setStatus = (text: string) => (statusEl.textContent = text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const terminal = new LabTerminal($('#terminal'), {
  onOpen: () => setStatus('Connected'),
  onClose: () => void onTerminalClosed(),
});

let lab: LabDetail | null = null;
let stepIndex = 0;
let session: Session | null = null;
let countdown: number | undefined;

// The active session id survives page refreshes. Phase 4 ties sessions to a user instead.
const STORAGE_KEY = 'laas.session';
function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode etc.): refresh just won't resume
  }
}
function recall(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

// --- catalog view ---------------------------------------------------------

async function showCatalog() {
  labEl.hidden = true;
  catalogEl.hidden = false;
  stopBtn.hidden = true;
  extendBtn.hidden = true;
  timerEl.textContent = '';
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
    card.onclick = () => startLab(summary.slug);
    catalogEl.append(card);
  }
}

// --- lab view -------------------------------------------------------------

async function showLab(slug: string) {
  lab = await getLab(slug);
  stepIndex = 0;
  catalogEl.hidden = true;
  labEl.hidden = false;
  labTitleEl.textContent = lab.title;
  terminal.reset();
  showStep();
  terminal.fit();
}

async function startLab(slug: string) {
  await showLab(slug);
  try {
    const created = await startSession(slug);
    remember(created.id);
    await follow(created);
  } catch (err) {
    showEnded(`Failed to start: ${(err as Error).message}`);
  }
}

/** Waits for a pending session to come up (users can read step 1 meanwhile), then attaches. */
async function follow(s: Session) {
  session = s;
  stopBtn.textContent = 'Stop lab';
  stopBtn.hidden = false;
  while (s.state === 'pending') {
    setStatus('Starting lab…');
    await sleep(1000);
    s = await getSession(s.id);
    if (session?.id !== s.id) return; // user stopped it meanwhile
    session = s;
  }
  if (s.state !== 'running') return showEnded(s);

  extendBtn.hidden = false;
  startCountdown();
  terminal.connect(s.id);
}

/** The socket dropped without us asking: lab ended, shell exited, or the API restarted. */
async function onTerminalClosed() {
  const id = session?.id;
  if (!id) return;
  const s = await getSession(id).catch(() => null);
  if (session?.id !== id) return;
  if (!s) {
    setStatus('API unreachable, retrying…');
    await sleep(2000);
    return onTerminalClosed();
  }
  session = s;
  if (s.state !== 'running') return showEnded(s);
  setStatus('Reconnecting…');
  await sleep(1000);
  if (session?.id === id) terminal.connect(id);
}

const END_MESSAGES: Record<NonNullable<Session['endReason']>, string> = {
  user: 'You stopped this lab.',
  expired: "Time's up! This lab has expired.",
  idle: 'This lab was stopped because nobody was connected to it.',
  container_lost: 'The lab environment stopped unexpectedly.',
  provision_failed: 'The lab failed to start.',
  interrupted: 'The lab was interrupted while starting.',
};

function showEnded(s: Session | string) {
  stopCountdown();
  terminal.disconnect();
  remember(null);
  session = null;
  extendBtn.hidden = true;
  stopBtn.textContent = 'Back to labs';
  stopBtn.hidden = false;
  if (typeof s === 'string') return setStatus(s);
  const message = s.endReason ? END_MESSAGES[s.endReason] : 'This lab has ended.';
  setStatus(s.error ? `${message} ${s.error}` : message);
}

// --- countdown & extend -----------------------------------------------------

function startCountdown() {
  stopCountdown();
  const render = () => {
    if (!session?.expiresAt) return;
    const left = Math.max(0, new Date(session.expiresAt).getTime() - Date.now());
    const min = Math.floor(left / 60_000);
    const sec = Math.floor((left % 60_000) / 1000);
    timerEl.textContent = `${min}:${String(sec).padStart(2, '0')} left`;
    timerEl.classList.toggle('warn', left < 5 * 60_000);
  };
  render();
  countdown = window.setInterval(render, 1000);
}

function stopCountdown() {
  clearInterval(countdown);
  timerEl.textContent = '';
}

extendBtn.onclick = async () => {
  if (!session) return;
  try {
    session = await extendSession(session.id);
  } catch (err) {
    setStatus(`Couldn't extend: ${(err as Error).message}`);
  }
};

// --- steps ----------------------------------------------------------------

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
  const s = session;
  session = null;
  stopCountdown();
  terminal.disconnect();
  remember(null);
  if (s) {
    stopBtn.disabled = true;
    setStatus('Stopping…');
    await stopSession(s.id).catch(() => {});
    stopBtn.disabled = false;
  }
  await showCatalog();
};

// --- boot -----------------------------------------------------------------

async function boot() {
  const id = recall();
  if (id) {
    const s = await getSession(id).catch(() => null);
    if (s && (s.state === 'pending' || s.state === 'running')) {
      await showLab(s.lab);
      return follow(s);
    }
    remember(null);
  }
  await showCatalog();
}

boot().catch((err) => setStatus(`Failed to load: ${(err as Error).message}`));
