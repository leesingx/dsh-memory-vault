/**
 * dsh-memory-vault —— 把「大肥鱼那套记忆库」做成独立插件。
 *
 * 特点：
 *   · 主副两级：副库 index.json（提炼条目）+ 主库 archive/*.jsonl（原始消息）
 *   · 七层结构：1 身份 / 2 月纪要 / 3 周纪要 / 4 日纪要 / 5 近缓存 / 6 长期事实 / 7 杂项
 *   · 潮汐记忆：检索分 = 命中分 × 权重^1.5 × e^(-时间/半衰期)，身份层永不过期
 *   · 自然遗忘：vivid → faded（只剩一句 memo）→ trace（只记得有这么回事）→ gone（进墓碑）
 *   · 锚定记忆：pin 住的永不衰减、不遗忘，检索加权
 *
 * 数据目录默认 <DSH_HOME>/memory-vault，首次使用自动创建，不含任何预置数据。
 */

import path from 'node:path';
import { createStore, defaultDir, LAYERS, FADE_DEFAULTS, todayKey } from './store.js';

export const name = 'dsh-memory-vault';

const CONFIG_DEFAULTS = {
  dir: '',
  fade: { ...FADE_DEFAULTS },
  guide: true,
};

function mergeConfig(config = {}) {
  return {
    ...CONFIG_DEFAULTS,
    ...config,
    fade: { ...CONFIG_DEFAULTS.fade, ...(config.fade ?? {}) },
  };
}

export function apply(ctx, rawConfig = {}) {
  const config = mergeConfig(rawConfig);
  const dir = config.dir && String(config.dir).trim() ? path.resolve(String(config.dir)) : defaultDir();
  const store = createStore({ dir });

  const log = (m) => {
    try { ctx.logger?.info?.(`dsh-memory-vault: ${m}`); } catch { /* ignore */ }
  };

  const reg = (def) => {
    try {
      return ctx.tools.register(def);
    } catch (error) {
      log(`注册工具 ${def.name} 失败：${error?.message ?? error}`);
      return undefined;
    }
  };

  reg({
    name: 'vault_remember',
    description:
      '把一条记忆写进「记忆库」（独立两级记忆库，默认空库）。七层：1 身份 / 2 月纪要 / 3 周纪要 / 4 日纪要 / 5 近缓存 / 6 长期事实 / 7 杂项。'
      + '写之前先用 vault_search 查重，同一件事不要写两条。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: {
        content: { type: 'string', description: '要记住的内容（一到三句话，抓住结论与关键细节）' },
        title: { type: 'string', description: '一句话标题，省略时取正文前 40 字' },
        layer: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7], description: '七层编号，省略按 kind 推断' },
        kind: { type: 'string', description: 'soul/user/fact/lesson/topic/project/rules/event/misc/feeling 等' },
        project: { type: 'string', description: '归属项目，全局留空' },
        keywords: { type: 'array', items: { type: 'string' }, description: '8~13 个关键词，供检索命中' },
        importance: { type: 'integer', description: '1~4，越大衰减越慢' },
        pin: { type: 'boolean', description: '是否钉住（永不衰减、永不遗忘）' },
        scope: { type: 'string', description: '主库分区标识，例如会话 id；省略则不写主库' },
      },
    },
    async execute(args = {}) {
      const e = store.add({
        content: args.content,
        title: args.title,
        layer: args.layer,
        kind: args.kind || 'fact',
        project: args.project || '',
        keywords: args.keywords,
        importance: args.importance ?? 1,
        pin: !!args.pin,
        key: args.scope || '',
      });
      return `✅ 已写入 ${e.id}（第 ${e.layer} 层 ${LAYERS[Number(e.layer)] || ''}，权重 ${e.importance}${e.pin ? '，已钉住' : ''}）\n标题：${e.title}`;
    },
  });

  reg({
    name: 'vault_search',
    description: '在记忆库里检索。分数 = 命中分 × 潮汐权重 × 锚点加成；faded 只返回一句 memo，trace 只返回「有这么回事」。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['q'],
      properties: {
        q: { type: 'string', description: '关键词或一句话' },
        k: { type: 'integer', description: '返回条数，默认 8' },
        layer: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7], description: '只看某一层' },
        project: { type: 'string', description: '只看某个项目' },
      },
    },
    async execute(args = {}) {
      const rows = store.search(args.q, { k: args.k ?? 8, layer: args.layer ?? null, project: args.project ?? null });
      if (!rows.length) return `没有命中「${args.q}」。`;
      return rows.map((r) => {
        const flags = [r.layerName, r.kind, r.pin ? '钉住' : '', r.state !== 'vivid' ? r.state : ''].filter(Boolean).join(' · ');
        return `- ${r.id}（${flags}，分 ${r.score}）：${r.title}\n  ${r.text}`;
      }).join('\n');
    },
  });

  reg({
    name: 'vault_read',
    description: '按 id 读取记忆库里的完整条目。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string', description: '条目 id，例如 v-00012' } },
    },
    async execute(args = {}) {
      const idx = store.loadIndex();
      const e = idx.entries.find((x) => x.id === args.id);
      if (!e) return `找不到条目 ${args.id}`;
      const body = e.state === 'trace' ? '（只记得有这么回事）' : e.summary;
      return `# ${e.id} ${e.title}\n层 ${e.layer}（${LAYERS[Number(e.layer)] || ''}）· ${e.kind} · 权重 ${e.importance} · 状态 ${e.state}${e.pin ? ' · 已钉住' : ''}\n项目：${e.project || '（全局）'}\n关键词：${(e.keywords || []).join(' / ')}\n\n${body}`;
    },
  });

  reg({
    name: 'vault_update',
    description: '修改已有条目（内容、标题、关键词、权重、层级、是否钉住）。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        title: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
        importance: { type: 'integer' },
        project: { type: 'string' },
        layer: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7] },
        pin: { type: 'boolean' },
      },
    },
    async execute(args = {}) {
      const e = store.update(args.id, args);
      return `✅ 已更新 ${e.id}：${e.title}（层 ${e.layer}，权重 ${e.importance}${e.pin ? '，已钉住' : ''}）`;
    },
  });

  reg({
    name: 'vault_anchor',
    description: '给条目打锚点（钉住）或拔锚。钉住 = 永不衰减、永不遗忘、检索加权。只钉「永远为真」的事。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['ids'],
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '一个或多个条目 id' },
        pin: { type: 'boolean', description: '默认 true；传 false 拔锚' },
      },
    },
    async execute(args = {}) {
      const touched = store.setAnchor(args.ids, args.pin !== false);
      return touched.length ? `✅ ${args.pin === false ? '拔锚' : '钉住'}：${touched.join(', ')}` : '没有匹配的条目。';
    },
  });

  reg({
    name: 'vault_layers',
    description: '看记忆库的分层结构与状态分布（七层各多少条、清晰/模糊/影子/沉底各多少、钉住多少）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      const s = store.layersStatus();
      const layers = Object.entries(s.layerNames).map(([n, nm]) => `${n} ${nm}：${s.layers[n] || 0}`).join('\n');
      return `共 ${s.total} 条，钉住 ${s.pinned} 条\n${layers}\n状态：清晰 ${s.states.vivid || 0} · 模糊 ${s.states.faded || 0} · 影子 ${s.states.trace || 0} · 沉底 ${s.states.gone || 0}\n目录：${s.dir}`;
    },
  });

  reg({
    name: 'vault_fade',
    description: '自然遗忘：status/plan 看计划，apply 真执行（沉底的进墓碑），rollback 让某条重新清晰。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['status', 'plan', 'apply', 'rollback'], description: '动作' },
        id: { type: 'string', description: 'rollback 时的条目 id' },
        dryRun: { type: 'boolean', description: 'apply 时先预演' },
        limit: { type: 'integer', description: '本次最多处理多少条' },
      },
    },
    async execute(args = {}) {
      const f = { ...config.fade, ...(args.limit ? { maxPerRun: args.limit } : {}) };
      const action = args.action || 'status';
      if (action === 'rollback') {
        const r = store.rollbackFade(args.id);
        return `✅ ${r.id} 已恢复清晰。`;
      }
      const dry = action !== 'apply' || args.dryRun === true;
      const r = store.applyFade(f, { dryRun: dry });
      if (action === 'status' || action === 'plan') {
        const s = store.layersStatus();
        return `模式 ${f.mode}（阈值 ${f.fadeAt}/${f.traceAt}/${f.dropAt}）\n待模糊 ${r.counts.faded} · 待成影子 ${r.counts.trace} · 待沉底 ${r.counts.gone}\n当前：清晰 ${s.states.vivid || 0} · 模糊 ${s.states.faded || 0} · 影子 ${s.states.trace || 0}`;
      }
      if (!r.changes.length) return '这次没有需要遗忘的条目。';
      return `${dry ? '（预演）' : '✅ 已执行'}${r.changes.map((c) => `\n- ${c.id} → ${c.to}（留存 ${c.r}）`).join('')}`;
    },
  });

  reg({
    name: 'vault_digest',
    description: '生成日纪要（把主库原始消息压成几行）。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['day', 'week', 'month'], description: '粒度，默认 day' },
        day: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        force: { type: 'boolean', description: '已有纪要时重新生成' },
      },
    },
    async execute(args = {}) {
      if ((args.scope || 'day') !== 'day') return '目前只支持日纪要（周/月纪要用 vault_remember 手工写一条）。';
      const day = args.day || todayKey();
      const r = store.digestDay(day, { force: !!args.force });
      if (!r.ok) return `没生成：${r.reason || '未知原因'}（${day}）`;
      return r.existing ? `已有纪要：${r.existing}（${day}，加 force 可重生成）` : `✅ 生成日纪要 ${r.id}（${day}，来自 ${r.lines} 条原文）`;
    },
  });

  reg({
    name: 'vault_grep',
    description: '在主库（原始消息）里按关键词全文搜索，返回命中行，用于「原话到底怎么说的」这类细节。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['q'],
      properties: {
        q: { type: 'string', description: '关键词' },
        scope: { type: 'string', description: '只搜某个分区（会话 id）' },
        k: { type: 'integer', description: '返回条数，默认 20' },
      },
    },
    async execute(args = {}) {
      const rows = store.grepArchive(args.q, { scope: args.scope || null, k: args.k ?? 20 });
      if (!rows.length) return `主库里没有命中「${args.q}」。`;
      return rows.map((r) => `[${new Date(r.at).toLocaleString('zh-CN')}] ${r.who ? r.who + '：' : ''}${r.text}`).join('\n');
    },
  });

  reg({
    name: 'vault_append',
    description: '往主库追加一条原始消息（一般由记忆库自己抓，不必手动调）。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: {
        text: { type: 'string', description: '原文' },
        who: { type: 'string', description: '说话人/角色' },
        scope: { type: 'string', description: '分区，例如会话 id' },
      },
    },
    async execute(args = {}) {
      store.appendMessage(args.scope || 'default', { text: args.text, who: args.who || '' });
      return '✅ 已追加到主库。';
    },
  });

  if (config.guide !== false) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const svc = ctx.get?.('systemPrompt');
      if (svc && typeof svc.section === 'function') {
        clearInterval(timer);
        try {
          svc.section({
            name: 'memory-vault:guide',
            order: 132,
            text: [
              '【记忆库 memory-vault】独立的两级记忆库（副库条目 + 主库原文），数据目录默认 <DSH_HOME>/memory-vault，不含任何预置数据。',
              '- 七层：1 身份 / 2 月纪要 / 3 周纪要 / 4 日纪要 / 5 近缓存 / 6 长期事实 / 7 杂项；身份层永不过期。',
              '- 潮汐：检索分 = 命中分 × 权重^1.5 × e^(-时间/半衰期)，被检索到会刷新“最近命中”。',
              '- 自然遗忘：vivid → faded（只剩一句 memo）→ trace（只记得有这么回事）→ gone（进墓碑）。钉住的不遗忘。',
              '- 用法：写前先 vault_search 查重；重要且永远为真的打 vault_anchor；问细节用 vault_grep 搜原文；偶尔 vault_layers 看结构。',
            ].join('\n'),
          });
        } catch (error) {
          log(`guide 挂载失败（不影响工具）：${error?.message ?? error}`);
        }
      } else if (tries > 20) {
        clearInterval(timer);
        log('systemPrompt 服务未就绪，手册未挂载（不影响工具）');
      }
    }, 1000);
    try { timer.unref?.(); } catch { /* ignore */ }
  }

  store.ensure();
  log(`已就绪，数据目录 ${dir}`);
}

export default { name, apply };
