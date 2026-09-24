import React from 'react';
import { Activity, Ban, CircleDot, Power, ShieldAlert, Zap } from 'lucide-react';
import { useTradingSession } from '../../hooks/useTradingSession';
import { ClosedTrade, EngineSnapshot, Position } from '../../types/trading';

const SUNKEN = 'border-t border-l border-[#808080] border-r border-b border-white';
const RAISED = 'border-t border-l border-white border-r border-b border-[#808080]';

const money = (n: number, digits = 2) =>
  `${n >= 0 ? '' : '-'}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

const pnlClass = (n: number) => (n > 0 ? 'text-emerald-700' : n < 0 ? 'text-rose-700' : 'text-slate-700');

const clock = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });

/** Win32 group box: a sunken well with a caption above it. */
const Section: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, right, children }) => (
  <div className="px-1.5 pt-1.5">
    <div className="flex items-center justify-between px-0.5 pb-0.5">
      <span className="text-[11px] font-bold text-[#0a246a]">{title}</span>
      {right}
    </div>
    <div className={`${SUNKEN} bg-white rounded-[1px]`}>{children}</div>
  </div>
);

const Stat: React.FC<{ label: string; value: React.ReactNode; className?: string }> = ({ label, value, className }) => (
  <div className="flex items-baseline justify-between px-2 py-[3px] odd:bg-[#f5f4ea]">
    <span className="text-[11px] text-slate-600">{label}</span>
    <span className={`text-[11px] font-mono font-bold ${className ?? 'text-slate-900'}`}>{value}</span>
  </div>
);

const XPButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}> = ({ onClick, disabled, title, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`${RAISED} bg-[#ece9d8] text-slate-900 px-2 py-[3px] text-[11px] rounded-[2px] flex items-center gap-1
      active:border-t-[#808080] active:border-l-[#808080] active:border-r-white active:border-b-white
      hover:bg-[#f3f1e6] disabled:opacity-40 disabled:hover:bg-[#ece9d8] disabled:active:border-t-white
      disabled:active:border-l-white disabled:cursor-not-allowed`}
  >
    {children}
  </button>
);

const PositionRow: React.FC<{ p: Position }> = ({ p }) => {
  const isLong = p.direction === 'long';
  const risk = p.stopLoss != null ? Math.abs(p.entryPrice - p.stopLoss) * p.qty : null;
  return (
    <div className="px-2 py-1 border-b border-[#e3e1d4] last:border-b-0">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-[11px] font-bold">
          <span className={`px-1 rounded-[1px] text-white text-[10px] ${isLong ? 'bg-emerald-600' : 'bg-rose-600'}`}>
            {isLong ? 'LONG' : 'SHORT'}
          </span>
          <span className="text-slate-900">{p.symbol}</span>
          <span className="font-mono text-slate-600">{p.qty}</span>
        </span>
        <span className={`text-[11px] font-mono font-bold ${pnlClass(p.unrealizedPnl)}`}>
          {money(p.unrealizedPnl)}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[10px] font-mono text-slate-600 mt-0.5">
        <span>entry {p.entryPrice.toFixed(2)}</span>
        <span>mark {p.markPrice.toFixed(2)}</span>
        {p.stopLoss != null && <span className="text-rose-700">SL {p.stopLoss.toFixed(2)}</span>}
        {p.takeProfit != null && <span className="text-emerald-700">TP {p.takeProfit.toFixed(2)}</span>}
        {risk != null && <span>risk {money(risk)}</span>}
      </div>
      {p.entryReason && <div className="text-[10px] text-slate-500 mt-0.5 truncate" title={p.entryReason}>{p.entryReason}</div>}
    </div>
  );
};

const TradeRow: React.FC<{ t: ClosedTrade }> = ({ t }) => (
  <div className="flex items-center gap-1.5 px-2 py-[3px] text-[10px] font-mono odd:bg-[#f5f4ea] hover:bg-[#316ac5] hover:text-white group">
    <span className="text-slate-500 group-hover:text-white/80 w-14 shrink-0">{clock(t.exitTs)}</span>
    <span className={`w-9 shrink-0 font-bold ${t.direction === 'long' ? 'text-emerald-700' : 'text-rose-700'} group-hover:text-white`}>
      {t.direction === 'long' ? 'LONG' : 'SHRT'}
    </span>
    <span className="flex-1 truncate text-slate-600 group-hover:text-white/90">{t.exitReason.replace(/_/g, ' ')}</span>
    {t.rMultiple != null && (
      <span className="text-slate-500 group-hover:text-white/80 shrink-0">{t.rMultiple.toFixed(2)}R</span>
    )}
    <span className={`shrink-0 font-bold ${pnlClass(t.netPnl)} group-hover:text-white`}>{money(t.netPnl)}</span>
  </div>
);

const Offline: React.FC<{ status: string }> = ({ status }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-center">
    <Ban className="w-6 h-6 text-[#aca899]" />
    <div className="text-[11px] font-bold text-slate-700">Paper trading server {status}</div>
    <div className={`${SUNKEN} bg-white px-2 py-1.5 text-left`}>
      <div className="text-[10px] text-slate-600 mb-1">Start it in a terminal:</div>
      <code className="text-[10px] font-mono text-[#0a246a] block">npm run paper</code>
    </div>
    <div className="text-[10px] text-slate-500 max-w-[16rem]">
      The chart keeps running without it. No exchange credentials are used in paper mode.
    </div>
  </div>
);

/**
 * Read-out and control surface for the paper-trading engine.
 *
 * Everything shown here is simulated: fills come from the paper broker walking
 * the live book, never from an exchange account.
 */
export const TradingPanel: React.FC = () => {
  const { snapshot, status, send } = useTradingSession();

  if (status !== 'connected' || !snapshot) {
    return <Offline status={status === 'connecting' ? 'not connected' : 'offline'} />;
  }

  const s: EngineSnapshot = snapshot;
  const netPnl = s.equity - s.startingEquity;
  const netPct = s.startingEquity > 0 ? (netPnl / s.startingEquity) * 100 : 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#ece9d8]">
      {/* Command rebar */}
      <div className="flex items-center gap-1 px-1.5 py-1 border-b border-[#aca899] shrink-0">
        <span className="px-1 py-[1px] rounded-[1px] bg-[#0a246a] text-white text-[10px] font-bold tracking-wide">PAPER</span>
        <span className={`flex items-center gap-0.5 text-[10px] font-bold ${s.armed ? 'text-emerald-700' : 'text-slate-500'}`}>
          <CircleDot className="w-2.5 h-2.5" />
          {s.armed ? 'ARMED' : 'IDLE'}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {s.armed ? (
            <XPButton onClick={() => send('disarm')} title="Stop opening new positions">
              <Power className="w-3 h-3" /> Disarm
            </XPButton>
          ) : (
            <XPButton onClick={() => send('arm')} title="Allow the strategy to open positions">
              <Zap className="w-3 h-3" /> Arm
            </XPButton>
          )}
          <XPButton
            onClick={() => send('flatten')}
            disabled={s.positions.length === 0}
            title="Close every open paper position at market"
          >
            Flatten
          </XPButton>
        </span>
      </div>

      {s.risk.killSwitch && (
        <div className="mx-1.5 mt-1.5 flex items-start gap-1.5 bg-[#fff4d6] border border-[#d9a441] px-2 py-1 rounded-[1px]">
          <ShieldAlert className="w-3.5 h-3.5 text-[#b45309] shrink-0 mt-[1px]" />
          <div className="flex-1">
            <div className="text-[11px] font-bold text-[#7c2d12]">Kill switch tripped</div>
            <div className="text-[10px] text-[#7c2d12]">{s.risk.killReason}</div>
          </div>
          <button
            onClick={() => send('reset_kill_switch')}
            className="text-[10px] underline text-[#0a246a] shrink-0"
          >
            Clear
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto pb-1.5">
        <Section
          title="Account"
          right={<span className="text-[10px] font-mono text-slate-500">{s.strategy}</span>}
        >
          <Stat label="Equity" value={`${money(s.equity)} USDT`} />
          <Stat label="Net P&L" value={`${money(netPnl)} (${netPct.toFixed(2)}%)`} className={pnlClass(netPnl)} />
          <Stat label="Realized" value={money(s.realized)} className={pnlClass(s.realized)} />
          <Stat label="Unrealized" value={money(s.unrealized)} className={pnlClass(s.unrealized)} />
          <Stat label="Fees paid" value={money(s.fees)} className="text-slate-600" />
          <Stat label="Today" value={money(s.risk.dailyPnl)} className={pnlClass(s.risk.dailyPnl)} />
          <Stat
            label="Drawdown"
            value={`${(s.risk.drawdown * 100).toFixed(2)}%`}
            className={s.risk.drawdown > 0.05 ? 'text-rose-700' : 'text-slate-700'}
          />
        </Section>

        <Section
          title="Open Positions"
          right={<span className="text-[10px] text-slate-500">{s.positions.length}</span>}
        >
          {s.positions.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-slate-500 italic">Flat — no open positions</div>
          ) : (
            s.positions.map((p) => <PositionRow key={p.symbol} p={p} />)
          )}
        </Section>

        <Section title="Performance">
          <Stat label="Trades closed" value={s.stats.tradesClosed} />
          <Stat label="Win rate" value={`${(s.stats.winRate * 100).toFixed(1)}%  (${s.stats.wins}W / ${s.stats.losses}L)`} />
          <Stat
            label="Profit factor"
            value={Number.isFinite(s.stats.profitFactor) ? s.stats.profitFactor.toFixed(2) : '∞'}
          />
          <Stat label="Avg R" value={s.stats.avgR.toFixed(2)} className={pnlClass(s.stats.avgR)} />
          <Stat label="Signals" value={`${s.stats.signalsTaken} taken / ${s.stats.signalsSeen} seen`} />
        </Section>

        <Section title="Recent Signals">
          {s.recentSignals.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-slate-500 italic">No signals yet</div>
          ) : (
            s.recentSignals.map((entry, i) => (
              <div key={`${entry.signal.ts}-${i}`} className="px-2 py-[3px] odd:bg-[#f5f4ea] border-b border-[#e3e1d4] last:border-b-0">
                <div className="flex items-center gap-1.5 text-[10px] font-mono">
                  <span className="text-slate-500 w-14 shrink-0">{clock(entry.signal.ts)}</span>
                  <span className={`font-bold w-9 shrink-0 ${entry.signal.direction === 'long' ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {entry.signal.direction === 'long' ? 'LONG' : 'SHRT'}
                  </span>
                  <span className="text-slate-700 shrink-0">{entry.signal.symbol}</span>
                  <span className={`ml-auto shrink-0 font-bold ${entry.accepted ? 'text-emerald-700' : 'text-slate-500'}`}>
                    {entry.accepted ? 'TAKEN' : 'SKIP'}
                  </span>
                </div>
                <div className="text-[10px] text-slate-500 truncate" title={entry.rejectedBy ?? entry.signal.reason}>
                  {entry.rejectedBy ?? entry.signal.reason}
                </div>
              </div>
            ))
          )}
        </Section>

        <Section title="Closed Trades">
          {s.closedTrades.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-slate-500 italic">Nothing closed yet</div>
          ) : (
            s.closedTrades.map((t) => <TradeRow key={t.id + t.exitTs} t={t} />)
          )}
        </Section>

        <div className="px-2 pt-2 flex items-center gap-1 text-[10px] text-slate-500">
          <Activity className="w-3 h-3" />
          <span className="font-mono truncate" title={s.runId}>{s.runId}</span>
        </div>
      </div>
    </div>
  );
};
