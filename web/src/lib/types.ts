export type Client = {
  id: string;
  name: string;
  timezone: string;
  color: string;
  approvalRequired: boolean;
  contactEmail: string | null;
  shareToken: string;
  archivedAt: string | null;
  channelCount: number;
  channelsAtRisk: number;
  voice: Voice | null;
  queueSlots: Slot[];
};

export type Slot = { day: number; time: string };

export type Voice = { description: string; audience: string; dos: string; donts: string; examples: string; language: string };

export type Channel = {
  id: string;
  clientId: string;
  platform: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  status: 'ok' | 'expiring' | 'failing' | 'disconnected';
  statusDetail: string | null;
  tokenExpiresAt: string | null;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
};

export type Media = { id: string; url: string; mime: string; alt: string; filename: string; size: number };

export type Attempt = { number: number; startedAt: string; finishedAt: string | null; outcome: string; code: string | null; httpStatus: number | null; message: string | null };

export type Target = {
  id: string;
  channelId: string;
  platform: string;
  channelName: string;
  channelHandle: string;
  channelAvatar: string | null;
  channelStatus: string;
  body: string | null;
  status: string;
  dueAt: string | null;
  nextAttemptAt: string | null;
  attempts: number;
  preflightOk: boolean | null;
  preflightMessage: string | null;
  publishedAt: string | null;
  remoteUrl: string | null;
  error: { code: string; message: string; hint: string } | null;
  followUps: { total: number; done: number; error: string | null; pending: boolean } | null;
  log?: Attempt[];
};

export type Comment = { id: string; author: string; fromClient: boolean; kind: string; body: string; createdAt: string };

export type Post = {
  id: string;
  clientId: string;
  status: string;
  approvalStatus: string;
  body: string;
  source: string;
  scheduledAt: string | null;
  thread: string[];
  firstComment: string;
  recycle: { days: number; times: number };
  recycledFrom: string | null;
  createdAt: string;
  updatedAt: string;
  media: Media[];
  targets: Target[];
  comments?: Comment[];
};

export type Alert = { id: string; kind: string; severity: 'error' | 'warning' | 'info'; title: string; detail: string | null; clientId: string | null; channelId: string | null; postId: string | null; createdAt: string; resolvedAt: string | null };

export type PlatformDef = {
  platform: string;
  label: string;
  available: boolean;
  unavailableReason: string | null;
  limits: { maxChars: number; maxImages: number; maxImageBytes: number; imageTypes: string[]; requiresMedia?: boolean };
  connect: { kind: 'fields' | 'oauth'; help: string; fields: { name: string; label: string; type: string; placeholder?: string; help?: string; required?: boolean }[] };
};

export type Me = { user: { id: string; email: string; name: string }; workspaces: { id: string; name: string; timezone: string; role: string }[]; workspaceId: string | null };

export type Snippet = { id: string; clientId: string | null; name: string; body: string };

export type Feed = { id: string; clientId: string; url: string; title: string; channelIds: string[]; template: string; mode: 'queue' | 'draft' | 'now'; active: boolean; lastCheckedAt: string | null; lastItemAt: string | null; lastError: string | null };
