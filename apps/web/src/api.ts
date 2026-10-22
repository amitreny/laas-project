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

// Mirrors toDto in apps/api/src/sessions.ts.
export interface Session {
  id: string;
  lab: string;
  state: 'pending' | 'running' | 'terminating' | 'terminated' | 'failed';
  createdAt: string;
  startedAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
  endReason: 'user' | 'expired' | 'idle' | 'container_lost' | 'provision_failed' | 'interrupted' | null;
  error: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const listLabs = () => request<LabSummary[]>('/api/labs');

export const getLab = (slug: string) => request<LabDetail>(`/api/labs/${slug}`);

export const startSession = (lab: string) =>
  request<Session>('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lab }),
  });

export const getSession = (id: string) => request<Session>(`/api/sessions/${id}`);

export const extendSession = (id: string) => request<Session>(`/api/sessions/${id}/extend`, { method: 'POST' });

export const stopSession = (id: string) => request<void>(`/api/sessions/${id}`, { method: 'DELETE' });
