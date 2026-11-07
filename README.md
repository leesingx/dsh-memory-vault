# dsh-memory-vault

独立的两级记忆库插件，给 DeepSeek Harness 用。

从「大肥鱼」那套 QQ 记忆库里抽出来的能力，**但不带任何她的记忆数据**：数据目录首次使用时自动创建，里面是空的。

## 能力

| 能力 | 说明 |
| --- | --- |
| 两级存储 | 副库 `index.json`（提炼过的一条）+ 主库 `archive/<scope>.jsonl`（原始消息） |
| 七层结构 | 1 身份 / 2 月纪要 / 3 周纪要 / 4 日纪要 / 5 近缓存 / 6 长期事实 / 7 杂项 |
| 潮汐记忆 | 检索分 = 命中分 × 权重^1.5 × e^(-时间/半衰期)；检索到会刷新「最近命中」 |
| 自然遗忘 | `vivid` → `faded`（只剩一句 memo）→ `trace`（只记得有这么回事）→ `gone`（进 `tombstones.json`） |
| 锚定记忆 | `pin` 住的条目不衰减、不遗忘，检索时加权 1.8× |
| 日纪要 | 把某天的主库原文压成几行，写成第 4 层条目 |

## 工具

| 工具 | 作用 |
| --- | --- |
| `vault_remember` | 写一条（content 必填，可选 layer/kind/project/keywords/importance/pin） |
| `vault_search` | 按关键词检索，返回带层、状态、分数的命中 |
| `vault_read` | 按 id 读完整条目 |
| `vault_update` | 改内容/标题/关键词/权重/层级/钉住 |
| `vault_anchor` | 打锚点（钉住）或拔锚 |
| `vault_layers` | 看七层分布与状态统计 |
| `vault_fade` | `status`/`plan`/`apply`/`rollback`，执行自然遗忘 |
| `vault_digest` | 生成某天的日纪要 |
| `vault_grep` | 在主库原文里全文搜索 |
| `vault_append` | 往主库追加一条原始消息 |

## 配置

在 profile 的 `cordis.patch.yml` 里可以覆盖：

```yaml
- id: memory-vault
  name: 'dsh-memory-vault'
  config:
    dir: ''            # 数据目录，默认 <DSH_HOME>/memory-vault
    guide: true        # 是否往 system prompt 挂一段使用手册
    fade:
      mode: observe    # observe 只看不落盘；apply 才真改状态
      fadeAt: 0.6
      traceAt: 0.25
      dropAt: 0.08
      maxPerRun: 15
```

## 安装

```bash
# 在 profile 目录里
npm i link:<本目录>
```

并把 `dsh-memory-vault` 加进 profile 的 `dsh.profile.bundles`，重启 DSH 后工具才会出现。

## 数据位置

```
<DSH_HOME>/memory-vault/
  index.json          副库
  archive/*.jsonl     主库（原始消息，按 scope 分文件）
  tombstones.json     沉底条目的墓碑（不真删）
```
