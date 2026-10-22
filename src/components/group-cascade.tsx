'use client';

import { useMemo } from 'react';

export interface CascadeGroup {
  id: number;
  name: string;
  parentId: number | null;
}

/**
 * Picks a group one level at a time. The first row has the top-level groups. Choosing one selects it and
 * shows ITS sub-groups on the next row; choose one of those to go deeper, or stay on the one you have.
 * Only the path you took is on screen, never the whole tree.
 */
export function GroupCascade({ groups, value, onChange }: { groups: CascadeGroup[]; value: number; onChange: (id: number) => void }) {
  const byId = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const chain = useMemo(() => {
    const out: CascadeGroup[] = [];
    for (let g = byId.get(value); g && !out.includes(g); g = g.parentId === null ? undefined : byId.get(g.parentId)) out.unshift(g);
    return out;
  }, [byId, value]);
  const childrenOf = (id: number | null) => groups.filter((g) => g.parentId === id);

  // Row 0 = top-level groups. Row i = sub-groups of chain[i - 1]. The last row (sub-groups of the group you
  // picked) has nothing selected yet: those are the choices for going one level deeper.
  const rows: { label: string; options: CascadeGroup[]; selected: number | null }[] = [{ label: 'Top level', options: childrenOf(null), selected: chain[0]?.id ?? null }];
  chain.forEach((g, i) => {
    const options = childrenOf(g.id);
    if (options.length) rows.push({ label: `Inside ${g.name}`, options, selected: chain[i + 1]?.id ?? null });
  });

  return (
    <div className="gc">
      {rows.map((r, i) => (
        <div className="gc-row" key={i}>
          <span className="gc-label">{r.label}</span>
          <div className="chips" role="group" aria-label={r.label}>
            {r.options.map((o) => (
              <button key={o.id} type="button" className={o.id === r.selected ? 'on' : ''} aria-pressed={o.id === r.selected} onClick={() => onChange(o.id)}>
                {o.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="muted" style={{ fontSize: 12 }}>
        Using <b style={{ color: 'var(--ink)' }}>{chain.map((g) => g.name).join(' › ')}</b>
        {rows[rows.length - 1].selected === null && rows.length > 1 ? '. Pick a group on the last row to go one level deeper, or keep this one.' : '.'}
      </div>
    </div>
  );
}
