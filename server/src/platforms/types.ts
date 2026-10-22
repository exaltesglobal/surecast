// Every social network is an adapter behind this interface. The publishing engine only
// knows about adapters, so adding a network never touches the engine.

export type Platform = 'bluesky' | 'mastodon' | 'telegram' | 'linkedin' | 'facebook' | 'instagram' | 'x';

/**
 * How a failure should be handled:
 * - temporary: retry later with backoff (rate limits, timeouts, server errors)
 * - auth: the connection is broken; mark the channel and stop until it is reconnected
 * - permanent: this post can never succeed as it is (too long, media rejected, duplicate)
 */
export type FailureKind = 'temporary' | 'auth' | 'permanent';

export class PublishError extends Error {
  constructor(
    public kind: FailureKind,
    public code: string,
    message: string,
    /** What the person should do about it, in plain words. */
    public hint: string,
    public httpStatus?: number,
    /** For rate limits: when the platform says we may try again. */
    public retryAfter?: Date,
    /** The platform's raw error body, for adapters that need to look inside it. */
    public body?: any,
  ) {
    super(message);
  }
}

export type MediaFile = { id: string; mime: string; filename: string; size: number; alt: string; url: string; data: () => Promise<Buffer> };

export type PublishInput = { text: string; media: MediaFile[]; idempotencyKey: string };
export type PublishResult = { remoteId: string; url: string | null };

export type ChannelProfile = {
  name: string;
  handle: string;
  externalId: string;
  avatarUrl: string | null;
  credentials: Record<string, unknown>;
  tokenExpiresAt: Date | null;
};

export type ChannelCtx = {
  id: string;
  handle: string;
  externalId: string;
  credentials: Record<string, unknown>;
  tokenExpiresAt: Date | null;
  /** Adapters call this when they refresh tokens, so the new ones are saved. */
  saveCredentials: (credentials: Record<string, unknown>, tokenExpiresAt: Date | null) => Promise<void>;
};

export type Limits = {
  maxChars: number;
  maxImages: number;
  maxImageBytes: number;
  imageTypes: string[];
  requiresMedia?: boolean;
};

export type ConnectField = { name: string; label: string; type: 'text' | 'password' | 'url'; placeholder?: string; help?: string; required?: boolean };

export type Candidate = ChannelProfile & { platform: Platform; detail?: string };

export interface Adapter {
  platform: Platform;
  label: string;
  limits: Limits;
  /** True when a repeated publish request with the same idempotency key cannot create a duplicate. */
  idempotent?: boolean;
  /** False when the platform needs a developer app whose keys are not set. */
  available(): boolean;
  unavailableReason?: string;
  /** How a channel is connected: by filling in fields, or by OAuth redirect. */
  connect:
    | { kind: 'fields'; fields: ConnectField[]; help: string; submit(values: Record<string, string>): Promise<ChannelProfile> }
    | {
        kind: 'oauth';
        help: string;
        /** Extra fields asked before redirecting, e.g. a Mastodon instance. */
        fields?: ConnectField[];
        start(args: { state: string; redirectUri: string; values: Record<string, string> }): Promise<{ url: string; data?: Record<string, unknown> }>;
        finish(args: { code: string; redirectUri: string; data: Record<string, unknown> }): Promise<Candidate[]>;
      };
  /** Character count as the platform counts it. */
  count(text: string): number;
  /** Confirms the connection still works; may refresh tokens. Throws PublishError. */
  check(ch: ChannelCtx): Promise<{ tokenExpiresAt?: Date | null; name?: string; avatarUrl?: string | null }>;
  publish(ch: ChannelCtx, input: PublishInput): Promise<PublishResult>;
  /**
   * Follow-ups after a post goes out. "thread" networks chain replies into a thread (and the
   * first comment is a reply); "comment" networks only take comments on the post itself.
   */
  followUps?: 'thread' | 'comment';
  /** Posts a text reply (or comment) under parent; rootId is the original post. */
  reply?(ch: ChannelCtx, target: ReplyTarget, text: string, idempotencyKey: string): Promise<PublishResult>;
}

export type ReplyTarget = { parentId: string; rootId: string };
