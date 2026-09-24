import { EngineSnapshot, TradingCommand } from '../types/trading';

export type TradingConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * Telemetry socket to the paper-trading server.
 *
 * The server is the single source of truth: this client never computes PnL or
 * decides anything, it renders whatever snapshot arrives. If the backend is not
 * running the panel simply shows as offline — the chart keeps working.
 */
export class TradingClient {
  private url: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private onSnapshot: (s: EngineSnapshot) => void;
  private onStatus: (s: TradingConnectionStatus) => void;

  constructor(url: string, handlers: { onSnapshot: (s: EngineSnapshot) => void; onStatus: (s: TradingConnectionStatus) => void }) {
    this.url = url;
    this.onSnapshot = handlers.onSnapshot;
    this.onStatus = handlers.onStatus;
  }

  connect() {
    if (this.destroyed) return;
    this.onStatus('connecting');

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => this.onStatus('connected');

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type: string; payload: EngineSnapshot };
        if (msg.type === 'snapshot') this.onSnapshot(msg.payload);
      } catch {
        // A malformed frame is not worth tearing the socket down for.
      }
    };

    this.ws.onclose = () => {
      if (this.destroyed) return;
      this.onStatus('disconnected');
      this.scheduleReconnect();
    };

    // onerror is always followed by onclose, which already handles reconnection.
    this.ws.onerror = () => {};
  }

  send(command: TradingCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: command }));
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.destroyed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3_000);
  }

  disconnect() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

export const TRADING_WS_URL: string =
  (import.meta.env?.VITE_TRADING_WS as string | undefined) ?? 'ws://localhost:8787';
