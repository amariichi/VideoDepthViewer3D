import { wsUrl } from '../utils/env';

export type PlaybackRole = 'remote' | 'viewer';
export type PlaybackAction = 'play' | 'pause' | 'seek';

export interface PlaybackEvent {
  type: 'command' | 'state' | 'session-ended' | 'error';
  action?: PlaybackAction;
  revision?: number;
  currentTimeMs?: number;
  paused?: boolean;
  originClientId?: string;
  originRole?: string;
  message?: string;
}

type EventListener = (event: PlaybackEvent) => void;
type StatusListener = (connected: boolean) => void;
type WebSocketFactory = (url: string) => WebSocket;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parsePlaybackEvent(value: unknown): PlaybackEvent | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (
    data.type !== 'command' &&
    data.type !== 'state' &&
    data.type !== 'session-ended' &&
    data.type !== 'error'
  ) {
    return null;
  }
  const action =
    data.action === 'play' || data.action === 'pause' || data.action === 'seek'
      ? data.action
      : undefined;
  if (data.type === 'command' && action === undefined) return null;
  return {
    type: data.type,
    action,
    revision: finiteNumber(data.revision),
    currentTimeMs: finiteNumber(data.current_time_ms),
    paused: typeof data.paused === 'boolean' ? data.paused : undefined,
    originClientId:
      typeof data.origin_client_id === 'string' ? data.origin_client_id : undefined,
    originRole: typeof data.origin_role === 'string' ? data.origin_role : undefined,
    message: typeof data.message === 'string' ? data.message : undefined,
  };
}

function createClientId(role: PlaybackRole): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `${role}-${random}` : `${role}-${Date.now()}-${Math.random()}`;
}

export class PlaybackControlClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private manuallyClosed = false;
  private pending: Array<{ type: unknown; message: string }> = [];
  private readonly eventListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly sessionId: string;
  private readonly role: PlaybackRole;
  private readonly clientId: string;
  private readonly socketFactory: WebSocketFactory;

  constructor(
    sessionId: string,
    role: PlaybackRole,
    clientId = createClientId(role),
    socketFactory: WebSocketFactory = (url) => new WebSocket(url)
  ) {
    this.sessionId = sessionId;
    this.role = role;
    this.clientId = clientId;
    this.socketFactory = socketFactory;
  }

  connect(): void {
    this.manuallyClosed = false;
    this.openSocket();
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.pending = [];
    this.emitStatus(false);
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  sendCommand(
    action: PlaybackAction,
    currentTimeMs: number,
    paused?: boolean
  ): void {
    this.send({
      type: 'command',
      action,
      current_time_ms: currentTimeMs,
      ...(typeof paused === 'boolean' ? { paused } : {}),
    });
  }

  sendState(currentTimeMs: number, paused: boolean): void {
    if (this.role !== 'viewer') return;
    this.send({ type: 'state', current_time_ms: currentTimeMs, paused });
  }

  private openSocket(): void {
    if (
      this.manuallyClosed ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    const socket = this.socketFactory(
      wsUrl(`/api/sessions/${encodeURIComponent(this.sessionId)}/control`)
    );
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.emitStatus(true);
      for (const pending of this.pending.splice(0)) socket.send(pending.message);
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket || typeof message.data !== 'string') return;
      try {
        const event = parsePlaybackEvent(JSON.parse(message.data));
        if (!event) return;
        this.eventListeners.forEach((listener) => listener(event));
        if (event.type === 'session-ended') this.close();
      } catch {
        // Ignore malformed control messages; media playback remains local.
      }
    };
    socket.onerror = () => this.emitStatus(false);
    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      this.emitStatus(false);
      if (event.code === 1008) {
        this.manuallyClosed = true;
        this.pending = [];
        return;
      }
      if (!this.manuallyClosed && this.reconnectTimer === null) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.openSocket();
        }, 1_000);
      }
    };
  }

  private send(payload: Record<string, unknown>): void {
    const message = JSON.stringify({
      ...payload,
      role: this.role,
      client_id: this.clientId,
    });
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(message);
      return;
    }
    if (payload.type === 'state' || payload.type === 'command') {
      this.pending = this.pending.filter(
        (pending) => pending.type !== payload.type
      );
    }
    this.pending.push({ type: payload.type, message });
    if (this.pending.length > 16) this.pending.shift();
  }

  private emitStatus(connected: boolean): void {
    this.statusListeners.forEach((listener) => listener(connected));
  }
}
