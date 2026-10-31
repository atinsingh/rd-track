import type { DirectoryResponse } from '@rd/contracts';
import { t } from './i18n';
import type { NavGroup } from './nav';

/** One thing the ⌘K palette can jump to. */
export interface PaletteItem {
  id: string;
  kind: 'page' | 'person' | 'project';
  label: string;
  /** Where it lives, shown beside the label: the nav group, the team, "Project". */
  hint: string;
  href: string;
  keywords: string;
}

export const paletteSections = (): { kind: PaletteItem['kind']; label: string }[] => [
  { kind: 'page', label: t('palette.pages') },
  { kind: 'person', label: t('palette.people') },
  { kind: 'project', label: t('palette.projects') },
];

/** Pages from the user's own navigation, plus the people and projects they manage. */
export function paletteItems(groups: NavGroup[], directory?: DirectoryResponse | null): PaletteItem[] {
  const pages = groups.flatMap((g) =>
    g.items.map<PaletteItem>((i) => ({ id: `page:${i.href}`, kind: 'page', label: i.label, hint: g.label, href: i.href, keywords: i.keywords ?? '' })),
  );
  const people = (directory?.people ?? []).map<PaletteItem>((p) => ({
    id: `person:${p.user_id}`,
    kind: 'person',
    label: p.display_name,
    hint: p.team_name,
    href: `/team/${encodeURIComponent(p.user_id)}?${new URLSearchParams({ team: p.team_id, name: p.display_name }).toString()}`,
    keywords: '',
  }));
  const projects = (directory?.projects ?? []).map<PaletteItem>((p) => ({
    id: `project:${p.id}`,
    kind: 'project',
    label: p.name,
    hint: t('palette.project'),
    href: `/projects?${new URLSearchParams({ project: p.id }).toString()}`,
    keywords: '',
  }));
  return [...pages, ...people, ...projects];
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** How well one query word matches: whole label start > a word start > anywhere > a keyword. */
function wordScore(word: string, label: string, extra: string): number {
  if (label.startsWith(word)) return 4;
  if (label.split(/[\s'’-]+/).some((w) => w.startsWith(word))) return 3;
  if (label.includes(word)) return 2;
  if (extra.split(/\s+/).some((w) => w.startsWith(word))) return 1;
  return 0;
}

/**
 * Items matching every word of the query, best first; ties keep their order
 * (pages, then people, then projects). An empty query lists the pages.
 */
export function searchPalette(items: PaletteItem[], query: string, limitPerKind = 6): PaletteItem[] {
  const words = fold(query).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.filter((i) => i.kind === 'page');
  const scored: { item: PaletteItem; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const label = fold(item.label);
    const extra = fold(`${item.hint} ${item.keywords}`);
    let score = 0;
    for (const w of words) {
      const s = wordScore(w, label, extra);
      if (s === 0) return;
      score += s;
    }
    scored.push({ item, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const perKind = new Map<string, number>();
  return scored
    .filter(({ item }) => {
      const n = perKind.get(item.kind) ?? 0;
      perKind.set(item.kind, n + 1);
      return n < limitPerKind;
    })
    .map((x) => x.item);
}
