'use client';

import { useState } from 'react';
import { Loading, PageHead, api, useAction, useApi } from '@/components/ui';
import type { Detection, SchemaDef } from '@/lib/schemas';

const SAMPLES: Record<string, { path: string; headers: string; body: string }> = {
  'OpenAI chat (Cline)': {
    path: '/v1/chat/completions',
    headers: '{}',
    body: JSON.stringify({ model: 'qwen3-coder-30b', stream: true, messages: [{ role: 'system', content: 'You are Cline…' }, { role: 'user', content: 'Fix the failing test' }] }, null, 2),
  },
  'Anthropic Messages (Claude Code)': {
    path: '/v1/chat/completions',
    headers: '{"anthropic-version": "2023-06-01"}',
    body: JSON.stringify({ model: 'claude', max_tokens: 1024, system: 'You are Claude Code', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }, null, 2),
  },
  Gemini: {
    path: '/v1/chat/completions',
    headers: '{}',
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }], generationConfig: { temperature: 0.2 } }, null, 2),
  },
};

export default function SchemasPage() {
  const { data, error, reload } = useApi<{ schemas: SchemaDef[]; policy: 'strict' | 'accept_known' }>('schemas');
  const [s, setS] = useState(SAMPLES['Anthropic Messages (Claude Code)']);
  const [det, setDet] = useState<Detection | null>(null);
  const { run } = useAction();
  const setPolicy = (p: string) => run(async () => { await api('settings', { method: 'PATCH', body: { schemaPolicy: p } }); await reload(); }, 'Schema policy saved');
  const detect = () =>
    run(async () => {
      let headers: Record<string, string> = {};
      try {
        headers = JSON.parse(s.headers || '{}');
      } catch {
        throw new Error('Headers must be a JSON object.');
      }
      setDet(await api<Detection>('schemas/detect', { body: { path: s.path, headers, body: s.body } }));
    });

  return (
    <>
      <PageHead title="Schemas" sub="Every request is scored against the API formats GuardRail knows. The best match is logged with each request.">
        {data && (
          <div className="seg" role="group" aria-label="Schema policy">
            <button type="button" className={data.policy === 'strict' ? 'on' : ''} onClick={() => setPolicy('strict')}>Strict</button>
            <button type="button" className={data.policy === 'accept_known' ? 'on' : ''} onClick={() => setPolicy('accept_known')}>Log only</button>
          </div>
        )}
      </PageHead>
      <div className="content">
        {!data ? (
          <Loading error={error} />
        ) : (
          <>
            <div className="note">
              {data.policy === 'strict'
                ? 'Strict: a request whose body looks like a different format than its endpoint expects is rejected with 422, and the error names the format it looks like.'
                : 'Log only: mismatches are logged but the request still goes through as long as the endpoint can forward it.'}{' '}
              The gateway forwards OpenAI Chat Completions and legacy Completions to vLLM; other formats are detected and named, not translated yet.
            </div>
            <div className="row">
              <section className="card" style={{ flex: '1 1 380px' }}>
                <div className="hd"><h2>Known schemas</h2></div>
                <div className="scroll">
                  <table className="tbl">
                    <thead><tr><th>Schema</th><th>Path</th><th>Forwarded</th></tr></thead>
                    <tbody>
                      {data.schemas.map((x) => (
                        <tr key={x.id}>
                          <td><div style={{ fontWeight: 600 }}>{x.name}</div><div className="muted small" style={{ whiteSpace: 'normal' }}>{x.description}</div></td>
                          <td className="mono">{x.path}</td>
                          <td><span className={`pill ${x.forwardable ? 'ok' : ''}`}>{x.forwardable ? 'Yes' : 'Detected only'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="card stack" style={{ flex: '1 1 420px', gap: 12 }}>
                <div className="hd" style={{ margin: 0 }}>
                  <h2>Detection tester</h2>
                  <select className="inp" style={{ width: 260, minHeight: 36 }} onChange={(e) => { setS(SAMPLES[e.target.value]); setDet(null); }} defaultValue="Anthropic Messages (Claude Code)" aria-label="Sample">
                    {Object.keys(SAMPLES).map((k) => <option key={k}>{k}</option>)}
                  </select>
                </div>
                <label><span className="lbl">Path</span><input className="inp mono" value={s.path} onChange={(e) => setS({ ...s, path: e.target.value })} /></label>
                <label><span className="lbl">Headers (JSON)</span><input className="inp mono" value={s.headers} onChange={(e) => setS({ ...s, headers: e.target.value })} /></label>
                <label><span className="lbl">Body</span><textarea style={{ minHeight: 160 }} value={s.body} onChange={(e) => setS({ ...s, body: e.target.value })} /></label>
                <button type="button" className="btn blk" style={{ alignSelf: 'flex-start' }} onClick={detect}>Detect</button>
                {det && (
                  <div className="stack">
                    <div className="wrap">
                      <span className="pill info">Looks like {det.best.name} ({Math.round(det.confidence * 100)}%)</span>
                      {data.policy === 'strict' && det.best.path !== s.path && det.confidence >= 0.6 && s.path.endsWith('completions') && <span className="pill bad">Strict would reject: 422</span>}
                    </div>
                    {det.scores.map((x) => (
                      <div key={x.id}>
                        <div className="between small" style={{ marginBottom: 4 }}><span>{x.name}</span><span className="mono muted">{Math.round(x.score * 100)}%</span></div>
                        <div className="meter"><i style={{ width: `${x.score * 100}%` }} /></div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}
