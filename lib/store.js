// dsh-memory-vault · 两级存储（副库 index.json + 主库 archive/*.jsonl）
// 七层结构 · 潮汐衰减 · 自然遗忘（vivid/faded/trace/gone）· 锚点 · 日周月纪要
//
// 设计取舍：
// - 副库只放“提炼过的一条”，主库按 scope 追加原始消息，检索时先副库、需要原文再 grep。
// - 潮汐与遗忘都是纯函数，随时可复算，不依赖后台任务；只有 applyFade 会落盘改状态。
// - 空库启动：首次调用才创建目录与 index.json，不塞任何示例数据。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const LAYERS = {
  1: '身份',
  2: '月纪要',
  3: '周纪要',
  4: '日纪要',
  5: '近缓存',
  6: '长期事实',
  7: '杂项',
};

export const LAYER_OF_KIND = {
  soul: 1, user: 1,
  digest_month: 2,
  digest_week: 3,
  digest_day: 4,
  recent: 5, cache: 5,
  fact: 6, lesson: 6, topic: 6, project: 6, rules: 6,
  misc: 7, event: 7, feeling: 7, plan: 7,
};

// 半衰期（天）：身份层永不过期
export const TAU_DAYS = {
  1: Infinity,
  2: Infinity,
  3: Infinity,
  4: Infinity,
  5: 7,
  6: 180,
  7: 60,
};

export const KIND_TAU = {
  soul: Infinity, user: Infinity,
  digest_month: Infinity, digest_week: Infinity, digest_day: Infinity,
  fact: 400, lesson: 400, topic: 300, project: 400, rules: Infinity,
  event: 45, misc: 60, feeling: 150, plan: 120, recent: 7,
};

export const FADE_DEFAULTS = {
  enabled: true,
  mode: 'observe',        // observe | apply
  fadeAt: 0.6,
  traceAt: 0.25,
  dropAt: 0.08,
  maxPerRun: 15,
  memoMaxChars: 40,
  specificityPenalty: 0.4,
  interferenceWeight: 0.3,
  interferenceMin: 0.5,
};

export const TIDE_FLOOR = 0.12;

export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function defaultDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'memory-vault');
}

export function createStore({ dir = defaultDir() } = {}) {
  const indexPath = path.join(dir, 'index.json');
  const archiveDir = path.join(dir, 'archive');
  const tombPath = path.join(dir, 'tombstones.json');

  function ensure() {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, JSON.stringify({ seq: 1, entries: [], updatedAt: Date.now() }, null, 1));
    }
  }

  function loadIndex() {
    ensure();
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const entries = Array.isArray(raw) ? raw : (raw.entries ?? []);
      return { seq: Number(raw?.seq) || entries.length + 1, entries };
    } catch {
      return { seq: 1, entries: [] };
    }
  }

  function saveIndex(idx) {
    ensure();
    idx.updatedAt = Date.now();
    const tmp = indexPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 1));
    fs.renameSync(tmp, indexPath);
  }

  // ---------- 派生量 ----------
  function layerOf(e) {
    const k = String(e.layer ?? '');
    if (/^[1-7]$/.test(k)) return Number(k);
    return LAYER_OF_KIND[String(e.kind || 'fact')] ?? 6;
  }

  function tauOf(e) {
    const k = String(e.kind || 'fact');
    if (Number.isFinite(KIND_TAU[k])) return KIND_TAU[k];
    const l = layerOf(e);
    return Number.isFinite(TAU_DAYS[l]) ? TAU_DAYS[l] : 180;
  }

  function ageDays(e, now = Date.now()) {
    const at = Number(e.at || e.createdAt) || now;
    return Math.max(0, (now - at) / 86400000);
  }

  // 潮汐：权重^1.5 × e^(-时间/半衰期)；钉住的不衰减但也不膨胀
  function tideWeight(e, now = Date.now()) {
    const tau = tauOf(e);
    const imp = Math.max(1, Number(e.importance ?? 1));
    const base = Math.pow(imp, 1.5);
    if (!Number.isFinite(tau)) return base;
    const since = Math.max(ageDays(e, now), e.lastHitAt ? ageDays({ at: e.lastHitAt }, now) * 0.55 : Infinity);
    return Math.max(TIDE_FLOOR * base, base * Math.exp(-since / tau));
  }

  function isPinned(e) {
    return !!e.pin;
  }

  // 自然遗忘：返回 vivid / faded / trace / gone
  function stateOf(e, f = FADE_DEFAULTS) {
    if (isPinned(e) || layerOf(e) <= 4) return 'vivid';
    const r = retention(e, f)(Date.now());
    if (r <= f.dropAt) return 'gone';
    if (r <= f.traceAt) return 'trace';
    if (r <= f.fadeAt) return 'faded';
    return 'vivid';
  }

  function retention(e, f = FADE_DEFAULTS) {
    return (now = Date.now()) => {
      const tau = tauOf(e);
      const imp = Math.max(1, Number(e.importance ?? 1));
      const boost = 1 + 0.3 * (imp - 1);
      const penalty = f.specificityPenalty * specificityOf(e);
      const eff = Number.isFinite(tau) ? tau * boost * (1 - penalty) : Infinity;
      const base = Number.isFinite(eff) ? Math.exp(-ageDays(e, now) / Math.max(1, eff)) : 1;
      return Math.max(0, Math.min(1, base));
    };
  }

  // “细节多不多”：数字/长句/专名多 ⇒ 更容易先模糊
  function specificityOf(e) {
    const text = String(e.summary || e.text || e.title || '');
    if (!text) return 0;
    const nums = (text.match(/\d/g) || []).length;
    const longs = text.length > 80 ? 1 : 0;
    return Math.min(1, nums * 0.06 + longs * 0.4);
  }

  function localMemo(e, max = FADE_DEFAULTS.memoMaxChars) {
    const text = String(e.title || e.summary || '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - 1)) + '…';
  }

  // ---------- 写 ----------
  function normalizeKeywords(kw) {
    const arr = Array.isArray(kw) ? kw : (kw ? String(kw).split(/[,，\s]+/) : []);
    return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))].slice(0, 16);
  }

  function add({ content, title, layer, kind = 'fact', project = '', keywords, importance = 1, pin = false, key = '', at, source = 'manual', manual = 0 }) {
    const text = String(content || '').trim();
    if (!text) throw new Error('content 不能为空');
    const idx = loadIndex();
    const id = `v-${String(idx.seq).padStart(5, '0')}`;
    idx.seq += 1;
    const entry = {
      id,
      at: Number(at) > 0 ? Number(at) : Date.now(),
      kind: String(kind || 'fact'),
      layer: layer || String(LAYER_OF_KIND[kind] ?? 6),
      title: String(title || text.slice(0, 40)),
      summary: text.slice(0, 800),
      project: String(project || ''),
      keywords: normalizeKeywords(keywords),
      importance: Math.max(1, Math.round(Number(importance) || 1)),
      pin: !!pin,
      key: String(key || ''),
      source,
      ...(manual ? { manual: 1 } : {}),
      state: 'vivid',
      hits: 0,
      lastHitAt: 0,
    };
    idx.entries.push(entry);
    saveIndex(idx);
    return entry;
  }

  function update(id, patch = {}) {
    const idx = loadIndex();
    const e = idx.entries.find((x) => x.id === id);
    if (!e) throw new Error(`找不到条目 ${id}`);
    if (typeof patch.content === 'string' && patch.content.trim()) {
      e.summary = patch.content.trim().slice(0, 800);
      if (!patch.title) e.title = e.summary.slice(0, 40);
    }
    if (typeof patch.title === 'string' && patch.title.trim()) e.title = patch.title.trim().slice(0, 80);
    if (patch.keywords) e.keywords = normalizeKeywords(patch.keywords);
    if (patch.importance != null) e.importance = Math.max(1, Math.round(Number(patch.importance) || 1));
    if (patch.project != null) e.project = String(patch.project);
    if (patch.layer != null) e.layer = String(patch.layer);
    if (patch.pin != null) e.pin = !!patch.pin;
    if (patch.state) e.state = patch.state;
    e.updatedAt = Date.now();
    saveIndex(idx);
    return e;
  }

  function setAnchor(ids, pin = true) {
    const idx = loadIndex();
    const list = Array.isArray(ids) ? ids : [ids];
    const touched = [];
    for (const id of list) {
      const e = idx.entries.find((x) => x.id === id);
      if (!e) continue;
      e.pin = !!pin;
      e.updatedAt = Date.now();
      touched.push(id);
    }
    if (touched.length) saveIndex(idx);
    return touched;
  }

  // ---------- 检索 ----------
  function tokenize(s) {
    return String(s || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0);
  }

  function scoreOf(e, terms) {
    const hay = `${e.title || ''} ${e.summary || ''} ${(e.keywords || []).join(' ')} ${e.project || ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (!t) continue;
      if ((e.keywords || []).some((k) => String(k).toLowerCase() === t)) score += 3;
      else if (String(e.title || '').toLowerCase().includes(t)) score += 2;
      else if (hay.includes(t)) score += 1;
    }
    return score;
  }

  function touch(ids) {
    if (!ids.length) return;
    const idx = loadIndex();
    const now = Date.now();
    for (const id of ids) {
      const e = idx.entries.find((x) => x.id === id);
      if (!e) continue;
      e.hits = (Number(e.hits) || 0) + 1;
      e.lastHitAt = now;
    }
    saveIndex(idx);
  }

  function search(q, { k = 8, layer = null, project = null, includeFaded = true } = {}) {
    const terms = tokenize(q);
    if (!terms.length) return [];
    const idx = loadIndex();
    const now = Date.now();
    const f = FADE_DEFAULTS;
    const hits = [];
    for (const e of idx.entries) {
      if (layer != null && Number(e.layer) !== Number(layer)) continue;
      if (project && String(e.project || '') !== String(project)) continue;
      const s = scoreOf(e, terms);
      if (s <= 0) continue;
      const st = e.state || stateOf(e, f);
      if (!includeFaded && st !== 'vivid') continue;
      const tide = tideWeight(e, now);
      const pinBoost = isPinned(e) ? 1.8 : 1;
      hits.push({ entry: e, score: s * tide * pinBoost, state: st });
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, Math.max(1, k));
    touch(top.map((h) => h.entry.id));
    return top.map(({ entry: e, score, state }) => ({
      id: e.id,
      layer: Number(e.layer),
      layerName: LAYERS[Number(e.layer)] || '',
      kind: e.kind,
      project: e.project,
      pin: isPinned(e),
      state,
      score: Number(score.toFixed(3)),
      tide: Number(tideWeight(e, now).toFixed(3)),
      title: e.title,
      text: state === 'trace' ? `（只记得有这么回事：${e.title}）` : (state === 'faded' ? (e.memo || localMemo(e)) : e.summary),
    }));
  }

  // ---------- 主库（原文） ----------
  function archivePath(scope) {
    const safe = String(scope || 'default').replace(/[^\w:.-]+/g, '_') + '.jsonl';
    return path.join(archiveDir, safe);
  }

  function appendMessage(scope, msg) {
    ensure();
    const row = JSON.stringify({ at: Date.now(), ...msg });
    fs.appendFileSync(archivePath(scope), row + '\n');
    return true;
  }

  function grepArchive(q, { scope = null, k = 20 } = {}) {
    ensure();
    const terms = tokenize(q);
    if (!terms.length) return [];
    const files = scope ? [archivePath(scope)] : fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(archiveDir, f));
    const out = [];
    for (const file of files) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const body = String(row.text || row.content || '');
        const low = body.toLowerCase();
        let score = 0;
        for (const t of terms) if (low.includes(t)) score += 1;
        if (!score) continue;
        out.push({ file: path.basename(file), at: row.at || 0, who: row.who || row.role || '', text: body.slice(0, 240), score });
      }
    }
    out.sort((a, b) => b.score - a.score || b.at - a.at);
    return out.slice(0, Math.max(1, k));
  }

  // ---------- 纪要 ----------
  function digestDay(day = todayKey(), { force = false, scope = null, maxChars = 1200 } = {}) {
    const idx = loadIndex();
    const existing = idx.entries.find((e) => e.kind === 'digest_day' && e.day === day);
    if (existing && !force) return { ok: true, existing: existing.id, day };
    const start = new Date(`${day}T00:00:00+08:00`).getTime();
    const end = start + 86400000;
    const rows = grepRange(start, end, scope);
    if (!rows.length) return { ok: false, reason: '这一天主库里没有原文', day };
    const text = renderDigest(rows, maxChars);
    if (existing && force) {
      const e = idx.entries.find((x) => x.id === existing.id);
      e.summary = text; e.at = end; e.state = 'vivid'; e.updatedAt = Date.now();
      saveIndex(idx);
      return { ok: true, updated: e.id, day, lines: rows.length };
    }
    const e = add({ content: text, kind: 'digest_day', title: `日纪要 ${day}`, keywords: [day, '日纪要'], importance: 2, at: end });
    const idx2 = loadIndex();
    const target = idx2.entries.find((x) => x.id === e.id);
    target.day = day; saveIndex(idx2);
    return { ok: true, id: e.id, day, lines: rows.length };
  }

  function grepRange(from, to, scope = null) {
    ensure();
    const files = scope ? [archivePath(scope)] : fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(archiveDir, f));
    const rows = [];
    for (const file of files) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        const at = Number(row.at) || 0;
        if (at >= from && at < to) rows.push(row);
      }
    }
    rows.sort((a, b) => (a.at || 0) - (b.at || 0));
    return rows;
  }

  function renderDigest(rows, maxChars = 1200) {
    const lines = rows.map((r) => {
      const t = new Date(r.at || Date.now());
      const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      const who = r.who || r.role || '';
      return `- ${hm} ${who ? who + '：' : ''}${String(r.text || r.content || '').replace(/\s+/g, ' ').slice(0, 80)}`;
    });
    let out = lines.join('\n');
    while (out.length > maxChars && lines.length > 6) {
      lines.shift();
      out = lines.join('\n');
    }
    return out;
  }

  // ---------- 遗忘 ----------
  function planFade(f = FADE_DEFAULTS, now = Date.now()) {
    const idx = loadIndex();
    const out = { faded: [], trace: [], gone: [] };
    for (const e of idx.entries) {
      if (isPinned(e) || layerOf(e) <= 4) continue;
      const r = retention(e, f)(now);
      const cur = e.state || 'vivid';
      if (r <= f.dropAt && cur !== 'gone') out.gone.push({ id: e.id, r: +r.toFixed(3), title: e.title });
      else if (r <= f.traceAt && cur === 'vivid') out.trace.push({ id: e.id, r: +r.toFixed(3), title: e.title });
      else if (r <= f.fadeAt && cur === 'vivid') out.faded.push({ id: e.id, r: +r.toFixed(3), title: e.title });
    }
    for (const key of Object.keys(out)) out[key] = out[key].slice(0, f.maxPerRun);
    return out;
  }

  function applyFade(f = FADE_DEFAULTS, { dryRun = true, now = Date.now() } = {}) {
    const plan = planFade(f, now);
    const changes = [];
    const idx = loadIndex();
    for (const [target, state] of [['faded', 'faded'], ['trace', 'trace'], ['gone', 'gone']]) {
      for (const item of plan[target]) {
        const e = idx.entries.find((x) => x.id === item.id);
        if (!e) continue;
        if (state === 'faded') e.memo = localMemo(e, f.memoMaxChars);
        e.state = state;
        e.fadedAt = now;
        changes.push({ id: e.id, to: state, r: item.r });
      }
    }
    if (!dryRun && changes.length) {
      saveIndex(idx);
      const gone = changes.filter((c) => c.to === 'gone');
      if (gone.length) {
        const tomb = fs.existsSync(tombPath) ? JSON.parse(fs.readFileSync(tombPath, 'utf8')) : [];
        for (const g of gone) {
          const e = idx.entries.find((x) => x.id === g.id);
          if (e) tomb.push({ ...e, tombAt: now });
        }
        fs.writeFileSync(tombPath, JSON.stringify(tomb.slice(-2000), null, 1));
      }
    }
    return { ok: true, dryRun, changes, counts: { faded: plan.faded.length, trace: plan.trace.length, gone: plan.gone.length } };
  }

  function layersStatus(now = Date.now()) {
    const idx = loadIndex();
    const byLayer = {};
    const states = { vivid: 0, faded: 0, trace: 0, gone: 0 };
    for (const e of idx.entries) {
      const l = layerOf(e);
      byLayer[l] = (byLayer[l] || 0) + 1;
      const st = e.state || 'vivid';
      states[st] = (states[st] || 0) + 1;
    }
    return {
      total: idx.entries.length,
      layers: byLayer,
      layerNames: LAYERS,
      states,
      pinned: idx.entries.filter(isPinned).length,
      dir,
    };
  }

  // ---------- 生命周期 ----------
  function pruneGone() {
    const idx = loadIndex();
    const before = idx.entries.length;
    idx.entries = idx.entries.filter((e) => e.state !== 'gone');
    if (idx.entries.length !== before) saveIndex(idx);
    return before - idx.entries.length;
  }

  function rollbackFade(id) {
    const idx = loadIndex();
    const e = idx.entries.find((x) => x.id === id);
    if (!e) throw new Error(`找不到条目 ${id}`);
    e.state = 'vivid';
    delete e.memo;
    delete e.fadedAt;
    e.updatedAt = Date.now();
    saveIndex(idx);
    return { ok: true, id };
  }

  // 按条目回读主库原文：以条目的时间为锚，取前后各若干条
  function recallAround(id, { scope = null, before = 30, after = 10 } = {}) {
    const idx = loadIndex();
    const e = idx.entries.find((x) => x.id === id);
    if (!e) throw new Error(`找不到条目 ${id}`);
    const at = Number(e.at) || Date.now();
    const useScope = scope || e.key || null;
    const rows = useScope ? grepRange(0, Date.now() + 86400000, useScope) : grepRange(0, Date.now() + 86400000, null);
    if (!rows.length) return { entry: e, scope: useScope, rows: [], note: '主库里这个分区没有原文' };
    let best = 0;
    for (let i = 0; i < rows.length; i += 1) {
      if (Math.abs((rows[i].at || 0) - at) < Math.abs((rows[best].at || 0) - at)) best = i;
    }
    const from = Math.max(0, best - Math.max(0, before));
    const to = Math.min(rows.length, best + Math.max(0, after) + 1);
    return { entry: e, scope: useScope, rows: rows.slice(from, to), index: best - from };
  }

  return {
    dir,
    ensure,
    loadIndex,
    add,
    update,
    setAnchor,
    search,
    appendMessage,
    grepArchive,
    recallAround,
    digestDay,
    grepRange,
    planFade,
    applyFade,
    layersStatus,
    rollbackFade,
    pruneGone,
    retention,
    tideWeight,
    stateOf,
    layerOf,
    isPinned,
  };
}
