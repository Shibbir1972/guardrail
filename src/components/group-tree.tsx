'use client';

import { useEffect, useMemo, useState } from 'react';
import { groupColor, initials } from './ui';

export interface TreeGroup {
  id: number;
  name: string;
  parentId: number | null;
  /** Shown on the right when `counts` is on. */
  keyCount?: number;
}

/**
 * A collapsible group tree. Only the root and the path down to the selected group are open to begin with, so a
 * big tree stays readable. A chevron opens or closes a branch; clicking a name selects it (and opens it).
 * Names never wrap: long ones are cut with an ellipsis and the full name is in the tooltip.
 */
export function GroupTree({ groups, selectedId, onSelect, counts = true }: { groups: TreeGroup[]; selectedId: number | null; onSelect: (id: number) => void; counts?: boolean }) {
  const { kids, byId, below } = useMemo(() => {
    const kids = new Map<number | null, TreeGroup[]>();
    for (const g of groups) kids.set(g.parentId, [...(kids.get(g.parentId) ?? []), g]);
    const byId = new Map(groups.map((g) => [g.id, g]));
    const below = (id: number): number => (kids.get(id) ?? []).reduce((n, c) => n + 1 + below(c.id), 0);
    return { kids, byId, below };
  }, [groups]);

  const pathTo = (id: number | null): number[] => {
    const out: number[] = [];
    for (let g = id === null ? undefined : byId.get(id); g && g.parentId !== null; g = byId.get(g.parentId)) out.push(g.parentId);
    return out;
  };
  const [open, setOpen] = useState<Set<number>>(() => new Set([...(kids.get(null) ?? []).map((r) => r.id), ...pathTo(selectedId)]));
  // Whatever gets selected (here or from the URL) is always visible.
  useEffect(() => {
    setOpen((prev) => {
      const need = pathTo(selectedId);
      return need.every((n) => prev.has(n)) ? prev : new Set([...prev, ...need]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, byId]);

  const toggle = (id: number) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const node = (g: TreeGroup) => {
    const children = kids.get(g.id) ?? [];
    const isOpen = open.has(g.id);
    const [bg, fg] = groupColor(g.id, g.parentId === null);
    return (
      <li key={g.id} className="gt-item" role="treeitem" aria-expanded={children.length ? isOpen : undefined} aria-selected={g.id === selectedId}>
        <div className={g.id === selectedId ? 'gt-row on' : 'gt-row'}>
          {children.length ? (
            <button type="button" className="gt-chev" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${g.name}`} onClick={() => toggle(g.id)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
          ) : (
            <span className="gt-chev gt-leaf" aria-hidden="true" />
          )}
          <button
            type="button"
            className="gt-name"
            title={g.name}
            onClick={() => {
              onSelect(g.id);
              if (children.length) setOpen((prev) => new Set([...prev, g.id]));
            }}
          >
            <span className="gdot" style={{ background: bg, color: fg }}>{initials(g.name)}</span>
            <span className="gt-txt">{g.name}</span>
          </button>
          {children.length > 0 && !isOpen && <span className="gt-more" title={`${below(g.id)} group${below(g.id) === 1 ? '' : 's'} inside`}>+{below(g.id)}</span>}
          {counts && g.keyCount !== undefined && (
            <span className="gt-count">
              {g.keyCount} key{g.keyCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {children.length > 0 && isOpen && (
          <ul className="gt-kids" role="group">
            {children.map(node)}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ul className="gt" role="tree" aria-label="Group tree">
      {(kids.get(null) ?? []).map(node)}
    </ul>
  );
}
