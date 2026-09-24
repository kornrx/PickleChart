import { useCallback, useEffect, useRef, useState } from 'react';
import { TradingClient, TradingConnectionStatus, TRADING_WS_URL } from '../services/tradingClient';
import { EngineSnapshot, TradingCommand } from '../types/trading';

/** Subscribes to the paper-trading server and exposes its latest snapshot. */
export function useTradingSession(url: string = TRADING_WS_URL) {
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [status, setStatus] = useState<TradingConnectionStatus>('connecting');
  const clientRef = useRef<TradingClient | null>(null);

  useEffect(() => {
    const client = new TradingClient(url, { onSnapshot: setSnapshot, onStatus: setStatus });
    clientRef.current = client;
    client.connect();
    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [url]);

  const send = useCallback((command: TradingCommand) => {
    clientRef.current?.send(command);
  }, []);

  return { snapshot, status, send };
}
