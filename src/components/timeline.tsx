import type { Step } from '@/lib/logs';
import { ms } from './ui';

/** The numbered "what happened" list for one request. */
export function Timeline({ steps }: { steps: Step[] }) {
  return (
    <div className="tl">
      {steps.map((s, i) => (
        <div className="ti" key={i}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span className={`dot ${s.tone}`}>{i + 1}</span>
            {i < steps.length - 1 && <span className="tline" />}
          </div>
          <div className="tbody">
            <div className="between" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <b>{s.head}</b>
              <span className="mono muted">{ms(s.ms)}</span>
            </div>
            <div className="muted">{s.text}</div>
            {s.quote && <div className="quote">{s.quote}</div>}
            {s.why && <div className="why">{s.why}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
