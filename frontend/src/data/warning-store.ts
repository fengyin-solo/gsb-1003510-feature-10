import { listRows } from './local-store'
import type { EntryRow, WarningPartition, WarningVersion } from './types'

// 阈值版本单独存一份，不走 local-store 的内存缓存：发布动作要做跨终端的乐观校验，
// 每次都直接读 localStorage 里的最新内容，两个终端同时操作才不会互相覆盖。
const VERSION_STORAGE_KEY = 'hydrology-monitor-station:warning-versions'

// 旧配置缺少生效时间时的兼容默认值：视为历史遗留，从一开始就生效。
const LEGACY_EFFECTIVE_AT = '2000-01-01 00:00'

function toNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

export function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 首次打开时把旧的「已生效」阈值行迁移成历史发布版本，缺生效时间的按兼容规则补齐。 */
function buildLegacyVersions(): WarningVersion[] {
  const legacyRows = listRows('warning').filter((row) => String(row.status) === '已生效')
  const byStation = new Map<string, EntryRow[]>()
  for (const row of legacyRows) {
    const station = String(row['站点编号'] ?? '')
    if (!station) continue
    byStation.set(station, [...(byStation.get(station) ?? []), row])
  }
  const versions: WarningVersion[] = []
  let id = 1
  for (const [station, rows] of byStation) {
    const partitions: WarningPartition[] = []
    for (const row of rows) {
      const 蓝色阈值 = toNumber(row['蓝色阈值'])
      const 黄色阈值 = toNumber(row['黄色阈值'])
      const 橙色阈值 = toNumber(row['橙色阈值'])
      const 红色阈值 = toNumber(row['红色阈值'])
      // 占位或损坏的旧数据没法转成数值阈值，跳过，不作为历史版本发布。
      if (蓝色阈值 === null || 黄色阈值 === null || 橙色阈值 === null || 红色阈值 === null) continue
      const 生效时间 = String(row['生效时间'] ?? '').trim() || LEGACY_EFFECTIVE_AT
      partitions.push({
        监测类型: String(row['监测类型'] ?? '水位'),
        站点编号: station,
        蓝色阈值,
        黄色阈值,
        橙色阈值,
        红色阈值,
        保证水位: null,
        生效时间,
        来源配置编号: String(row['配置编号'] ?? ''),
        合并说明: String(row['生效时间'] ?? '').trim() ? '' : '旧配置缺少生效时间，按历史生效处理',
      })
    }
    if (!partitions.length) continue
    versions.push({
      id,
      版本号: `V0-${station}`,
      status: '已发布',
      baseVersionId: null,
      站点编号: station,
      操作人: '系统迁移',
      生成时间: LEGACY_EFFECTIVE_AT,
      发布时间: LEGACY_EFFECTIVE_AT,
      停用时间: null,
      覆盖要求: partitions.map((p) => p.监测类型),
      缺失类型: [],
      partitions,
    })
    id += 1
  }
  return versions
}

export function readVersions(): WarningVersion[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(VERSION_STORAGE_KEY)
  if (raw === null) {
    const legacy = buildLegacyVersions()
    writeVersions(legacy)
    return legacy
  }
  try {
    return JSON.parse(raw) as WarningVersion[]
  } catch {
    return []
  }
}

export function writeVersions(versions: WarningVersion[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(VERSION_STORAGE_KEY, JSON.stringify(versions))
  }
}

export function nextVersionId(versions: WarningVersion[]): number {
  return versions.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

export function nextVersionLabel(id: number): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  return `V${day}-${String(id).padStart(2, '0')}`
}
