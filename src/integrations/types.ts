export const EVENT_TYPES = [
  'release.published',
  'release.deleted',
  'push',
  'issue.opened',
  'pr.opened',
  'pr.merged',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type AnyEventType = EventType | 'test';

export interface DropEvent {
  id: string;
  type: AnyEventType;
  at: number;
  actor: string;
  project: { slug: string; name: string } | null;
  title: string;
  body: string;
  url: string;
  data: Record<string, unknown>;
}

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'url' | 'secret';
  required?: boolean;
  placeholder?: string;
  help?: string;
  secret?: boolean;
}

export type Config = Record<string, string>;

export interface OutgoingRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body: string;
}

export interface Connector {
  type: string;
  label: string;
  description: string;
  fields: FieldDef[];
  check?(config: Config): string | null;
  build(config: Config, event: DropEvent): OutgoingRequest | Promise<OutgoingRequest>;
}

export const json = (value: unknown): string => JSON.stringify(value);

export const jsonHeaders = { 'content-type': 'application/json' };

export function plainText(event: DropEvent, link = event.url): string {
  return [event.title, event.body, link].filter(Boolean).join('\n');
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function httpsUrl(value: string | undefined, label: string): string | null {
  if (!value) return `${label} is required`;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') return `${label} must start with https://`;
  } catch {
    return `${label} is not a valid URL`;
  }
  return null;
}
