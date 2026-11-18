// Which columns of the Projects list fit at a given width. Pure, so the fold
// points are tested instead of eyeballed. Narrower lists fold the branch chip
// under the name line first, then drop Touched, then Sync.
export interface ProjectCols { branchCol: boolean; touched: boolean; sync: boolean; template: string }

const NAME_MIN = 150, GAP = 8, PAD = 48;
// check(16) tile(22) name branch(150) tabs(44) changes(56) sync(60) touched(72) actions(76)
const widths = (c: { branchCol: boolean; touched: boolean; sync: boolean }) =>
  [16, 22, NAME_MIN, c.branchCol ? 150 : 0, 44, 56, c.sync ? 60 : 0, c.touched ? 72 : 0, 76].filter((w) => w > 0);
const need = (c: { branchCol: boolean; touched: boolean; sync: boolean }) => { const w = widths(c); return w.reduce((a, b) => a + b, 0) + (w.length - 1) * GAP + PAD + 12; };

export function projectCols(width: number): ProjectCols {
  const tiers = [
    { branchCol: true, touched: true, sync: true },
    { branchCol: false, touched: true, sync: true },
    { branchCol: false, touched: false, sync: true },
    { branchCol: false, touched: false, sync: false },
  ];
  const c = tiers.find((t) => width >= need(t)) ?? tiers[tiers.length - 1]!;
  const template = ["16px", "22px", "minmax(0,1fr)", c.branchCol && "150px", "44px", "56px", c.sync && "60px", c.touched && "72px", "76px"].filter(Boolean).join(" ");
  return { ...c, template };
}

/** "N worktrees", or "N wt" once the branch is folded under the name and the cell is ~150 px. */
export function worktreeLabel(n: number, folded: boolean): string {
  return folded ? `${n} wt` : `${n} worktree${n === 1 ? "" : "s"}`;
}
