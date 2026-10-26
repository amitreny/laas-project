// Mirrors toSummary / toDetail in apps/api/src/catalog.ts.
export interface LabSummary {
  slug: string;
  title: string;
  description: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  ttlMinutes: number;
  stepCount: number;
}

export interface LabDetail extends LabSummary {
  steps: { title: string; markdown: string }[];
}

export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

// Mirrors toDto in apps/api/src/sessions.ts.
export interface Session {
  id: string;
  lab: string;
  userId: string | null;
  state: 'pending' | 'running' | 'terminating' | 'terminated' | 'failed';
  createdAt: string;
  startedAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
  endReason: 'user' | 'expired' | 'idle' | 'container_lost' | 'provision_failed' | 'interrupted' | null;
  error: string | null;
}

/** Thrown on 401, so the UI can send the user to the sign-in screen from anywhere. */
export class AuthError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body.message ?? body.error ?? `${res.status} ${res.statusText}`;
    throw res.status === 401 ? new AuthError(message) : new Error(message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const postJson = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const me = () => request<User>('/api/auth/me');

export const signUp = (email: string, password: string) => postJson<User>('/api/auth/signup', { email, password });

export const logIn = (email: string, password: string) => postJson<User>('/api/auth/login', { email, password });

export const logOut = () => request<void>('/api/auth/logout', { method: 'POST' });

export const listLabs = () => request<LabSummary[]>('/api/labs');

export const getLab = (slug: string) => request<LabDetail>(`/api/labs/${slug}`);

export const myActiveSessions = () => request<Session[]>('/api/sessions');

export const startSession = (lab: string) => postJson<Session>('/api/sessions', { lab });

export const getSession = (id: string) => request<Session>(`/api/sessions/${id}`);

export const extendSession = (id: string) => request<Session>(`/api/sessions/${id}/extend`, { method: 'POST' });

export const getTicket = (id: string) =>
  request<{ ticket: string }>(`/api/sessions/${id}/ticket`, { method: 'POST' }).then((r) => r.ticket);

export const stopSession = (id: string) => request<void>(`/api/sessions/${id}`, { method: 'DELETE' });
