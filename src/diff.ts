/** Minimal line-based unified diff (LCS). Good enough for instruction edits of a few thousand lines. */
export function unifiedDiff(label: string, a: string, b: string, context = 3): string {
  if (a === b) return "";
  const x = a.split("\n");
  const y = b.split("\n");
  // Trim common prefix/suffix to keep the LCS table small.
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xm = x.slice(pre, x.length - suf);
  const ym = y.slice(pre, y.length - suf);
  type Op = { t: " " | "-" | "+"; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: " ", s: x[i]!, ai: i, bi: i });
  if (xm.length * ym.length > 4_000_000) {
    xm.forEach((s, i) => ops.push({ t: "-", s, ai: pre + i, bi: pre }));
    ym.forEach((s, i) => ops.push({ t: "+", s, ai: pre + xm.length, bi: pre + i }));
  } else {
    const n = xm.length, m = ym.length;
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = xm[i] === ym[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xm[i] === ym[j]) { ops.push({ t: " ", s: xm[i]!, ai: pre + i, bi: pre + j }); i++; j++; }
      else if (i < n && (j >= m || L[i + 1]![j]! >= L[i]![j + 1]!)) { ops.push({ t: "-", s: xm[i]!, ai: pre + i, bi: pre + j }); i++; }
      else { ops.push({ t: "+", s: ym[j]!, ai: pre + i, bi: pre + j }); j++; }
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ t: " ", s: x[x.length - suf + k]!, ai: x.length - suf + k, bi: y.length - suf + k });
  // Group into hunks.
  const out: string[] = [`--- ${label} (current)`, `+++ ${label} (proposed)`];
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k]!.t === " ") k++;
    if (k >= ops.length) break;
    let start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length) {
      if (ops[end]!.t !== " ") { end++; continue; }
      let run = 0;
      while (end + run < ops.length && ops[end + run]!.t === " ") run++;
      if (end + run >= ops.length || run > context * 2) { end = Math.min(ops.length, end + context); break; }
      end += run;
    }
    const hunk = ops.slice(start, end);
    const aStart = hunk[0]!.ai + 1, bStart = hunk[0]!.bi + 1;
    const aLen = hunk.filter((o) => o.t !== "+").length, bLen = hunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of hunk) out.push(o.t + o.s);
    k = end;
  }
  return out.join("\n");
}
