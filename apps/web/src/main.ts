import {
  AuthError,
  extendSession,
  getLab,
  getSession,
  getTicket,
  listLabs,
  logIn,
  logOut,
  me,
  myActiveSessions,
  signUp,
  startSession,
  stopSession,
  type LabDetail,
  type Session,
  type User,
} from './api';
import { renderStep } from './instructions';
import { LabTerminal } from './terminal';
import './style.css';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const statusEl = $<HTMLSpanElement>('#status');
const timerEl = $<HTMLSpanElement>('#timer');
const extendBtn = $<HTMLButtonElement>('#extend');
const stopBtn = $<HTMLButtonElement>('#stop');
const userEl = $<HTMLSpanElement>('#user');
const logoutBtn = $<HTMLButtonElement>('#logout');
const authEl = $<HTMLElement>('#auth');
const authForm = $<HTMLFormElement>('#auth-form');
const authHeading = $<HTMLElement>('#auth-heading');
const authSubmit = $<HTMLButtonElement>('#auth-submit');
const authError = $<HTMLElement>('#auth-error');
const authSwitch = $<HTMLAnchorElement>('#auth-switch');
const authSwitchText = $<HTMLSpanElement>('#auth-switch-text');
const emailInput = $<HTMLInputElement>('#email');
const passwordInput = $<HTMLInputElement>('#password');
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

let user: User | null = null;
let lab: LabDetail | null = null;
let stepIndex = 0;
let session: Session | null = null;
let countdown: number | undefined;

function showView(view: 'auth' | 'catalog' | 'lab') {
  authEl.hidden = view !== 'auth';
  catalogEl.hidden = view !== 'catalog';
  labEl.hidden = view !== 'lab';
}

/** Stop following the current session (it may keep running on the server). */
function detach() {
  stopCountdown();
  terminal.disconnect();
  session = null;
}

/** Any 401 sends the user back to the sign-in screen; other errors go to the status line. */
function handleError(err: unknown, prefix = '') {
  if (err instanceof AuthError) return showAuth('Your login has expired. Please sign in again.');
  setStatus(`${prefix}${(err as Error).message}`);
}

// --- auth -----------------------------------------------------------------

let authMode: 'login' | 'signup' = 'login';

function setAuthMode(mode: 'login' | 'signup') {
  authMode = mode;
  const signup = mode === 'signup';
  authHeading.textContent = signup ? 'Create an account' : 'Sign in';
  authSubmit.textContent = signup ? 'Create account' : 'Sign in';
  authSwitchText.textContent = signup ? 'Already have an account?' : 'No account yet?';
  authSwitch.textContent = signup ? 'Sign in' : 'Create one';
  // Lets password managers offer to generate a password on signup and fill one on login.
  passwordInput.autocomplete = signup ? 'new-password' : 'current-password';
  authError.textContent = '';
}

function showAuth(message = '') {
  detach();
  user = null;
  for (const el of [userEl, logoutBtn, stopBtn, extendBtn]) el.hidden = true;
  labTitleEl.textContent = '';
  setStatus('');
  showView('auth');
  setAuthMode(authMode);
  authError.textContent = message;
  emailInput.focus();
}

authSwitch.onclick = (e) => {
  e.preventDefault();
  setAuthMode(authMode === 'login' ? 'signup' : 'login');
};

authForm.onsubmit = async (e) => {
  e.preventDefault();
  authSubmit.disabled = true;
  authError.textContent = '';
  try {
    const submit = authMode === 'login' ? logIn : signUp;
    user = await submit(emailInput.value, passwordInput.value);
    passwordInput.value = '';
    await enterApp();
  } catch (err) {
    authError.textContent = (err as Error).message;
  } finally {
    authSubmit.disabled = false;
  }
};

// Logging out doesn't stop a running lab; with no terminal attached, the idle reaper ends it.
logoutBtn.onclick = async () => {
  await logOut().catch(() => {});
  showAuth();
};

async function enterApp() {
  userEl.textContent = user!.email + (user!.role === 'admin' ? ' (admin)' : '');
  userEl.hidden = false;
  logoutBtn.hidden = false;

  // The server knows whether we have a lab running, so resume it — from this tab, another tab, or another device.
  const active = (await myActiveSessions()).find((s) => s.state === 'pending' || s.state === 'running');
  if (active) {
    await showLab(active.lab);
    return follow(active);
  }
  await showCatalog();
}

// --- catalog view ---------------------------------------------------------

async function showCatalog() {
  showView('catalog');
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
  showView('lab');
  labTitleEl.textContent = lab.title;
  terminal.reset();
  showStep();
  terminal.fit();
}

async function startLab(slug: string) {
  try {
    await showLab(slug);
    await follow(await startSession(slug));
  } catch (err) {
    if (err instanceof AuthError) return handleError(err);
    showEnded(`Couldn't start the lab: ${(err as Error).message}`);
  }
}

/** Waits for a pending session to come up (users can read step 1 meanwhile), then attaches. */
async function follow(s: Session) {
  session = s;
  stopBtn.textContent = 'Stop lab';
  stopBtn.hidden = false;
  try {
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
    await connectTerminal(s.id);
  } catch (err) {
    handleError(err);
  }
}

/** Trade the login cookie for a fresh short-lived ticket, then open the terminal socket with it. */
async function connectTerminal(id: string) {
  const ticket = await getTicket(id);
  if (session?.id === id) terminal.connect(id, ticket);
}

/** The socket dropped without us asking: lab ended, shell exited, or the API restarted. */
async function onTerminalClosed() {
  const id = session?.id;
  if (!id) return;
  let s: Session;
  try {
    s = await getSession(id);
  } catch (err) {
    if (err instanceof AuthError) return handleError(err);
    setStatus('API unreachable, retrying…');
    await sleep(2000);
    return onTerminalClosed();
  }
  if (session?.id !== id) return;
  session = s;
  if (s.state !== 'running') return showEnded(s);
  setStatus('Reconnecting…');
  await sleep(1000);
  await connectTerminal(id).catch(() => onTerminalClosed());
}

const END_MESSAGES: Record<NonNullable<Session['endReason']>, string> = {
  user: 'You stopped this lab.',
  expired: "Time's up! This lab has expired.",
  idle: 'This lab was stopped because nobody was connected to it.',
  container_lost: 'The lab environment stopped unexpectedly.',
  disk_limit: 'This lab was stopped because it used more disk space than it is allowed.',
  provision_failed: 'The lab failed to start.',
  interrupted: 'The lab was interrupted while starting.',
};

function showEnded(s: Session | string) {
  detach();
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
    handleError(err, "Couldn't extend: ");
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
  detach();
  try {
    if (s) {
      stopBtn.disabled = true;
      setStatus('Stopping…');
      await stopSession(s.id);
    }
    await showCatalog();
  } catch (err) {
    handleError(err);
  } finally {
    stopBtn.disabled = false;
  }
};

// --- boot -----------------------------------------------------------------

async function boot() {
  try {
    user = await me();
  } catch (err) {
    if (err instanceof AuthError) return showAuth();
    throw err;
  }
  await enterApp();
}

boot().catch((err) => handleError(err, 'Failed to load: '));
