import { listRows } from '@/data/local-store'
import {
  nextVersionId,
  nextVersionLabel,
  nowText,
  readVersions,
  writeVersions,
} from '@/data/warning-store'
import type {
  ActionResult,
  CoverageReport,
  EntryRow,
  WarningPartition,
  WarningVersion,
  WaterLevelAlarm,
} from '@/data/types'

// 每个候选版本必须覆盖的监测类型；已发布版本覆盖过的类型也会并入要求，避免发布后丢分区。
export const REQUIRED_MONITOR_TYPES = ['水位', '流量', '雨量']

// 蓝色/黄色阈值与保证水位冲突时的合并规则：不得超过保证水位，统一下浮 0.1m 封顶。
const GUARANTEE_MARGIN = 0.1

// 只有这两种状态的配置行算是「草稿」，可以生成候选版本。
const DRAFT_STATUSES = ['草稿', '已调整']

function toNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

export function listWarningVersions(): WarningVersion[] {
  return readVersions()
}

export function publishedVersionFor(stationCode: string): WarningVersion | null {
  return (
    readVersions().find((item) => item.status === '已发布' && item['站点编号'] === stationCode) ??
    null
  )
}

function requiredTypes(versions: WarningVersion[], stationCode: string): string[] {
  const published = versions.find(
    (item) => item.status === '已发布' && item['站点编号'] === stationCode,
  )
  const covered = published ? published.partitions.map((p) => p.监测类型) : []
  return [...new Set([...REQUIRED_MONITOR_TYPES, ...covered])]
}

export function coverageOf(partitions: WarningPartition[], required: string[]): CoverageReport {
  const covered = required.filter((type) => partitions.some((p) => p.监测类型 === type))
  const missing = required.filter((type) => !covered.includes(type))
  const pass = missing.length === 0
  return {
    required,
    covered,
    missing,
    pass,
    text: pass
      ? `覆盖率检查通过：已覆盖 ${covered.length}/${required.length} 个监测类型`
      : `覆盖率检查未通过：已覆盖 ${covered.length}/${required.length} 个监测类型，缺少 ${missing.join('、')}`,
  }
}

/** 本站水位记录里的保证水位，作为蓝/黄阈值合并的封顶线；取观测到的最大值。 */
function stationGuaranteeLevel(stationCode: string): number | null {
  const levels = listRows('waterlevel')
    .filter((row) => String(row['站点编号']) === stationCode)
    .map((row) => toNumber(row['保证水位']))
    .filter((value): value is number => value !== null)
  return levels.length ? Math.max(...levels) : null
}

/**
 * 把一条草稿配置转成版本分区：
 * - 蓝色/黄色阈值超过保证水位时按「保证水位 - 0.1m」封顶，并保持 蓝色 ≤ 黄色；
 * - 旧配置缺少生效时间的，按候选生成时间补齐；
 * - 每次合并都写进合并说明，页面上能看出来动过哪里。
 */
function buildPartition(
  row: EntryRow,
  stationCode: string,
  guarantee: number | null,
  generatedAt: string,
): WarningPartition | null {
  const 蓝色阈值 = toNumber(row['蓝色阈值'])
  const 黄色阈值 = toNumber(row['黄色阈值'])
  const 橙色阈值 = toNumber(row['橙色阈值'])
  const 红色阈值 = toNumber(row['红色阈值'])
  if (蓝色阈值 === null || 黄色阈值 === null || 橙色阈值 === null || 红色阈值 === null) {
    return null
  }
  const notes: string[] = []
  let blue = 蓝色阈值
  let yellow = 黄色阈值
  if (guarantee !== null) {
    const cap = Number((guarantee - GUARANTEE_MARGIN).toFixed(2))
    if (黄色阈值 > cap) {
      notes.push(`黄色阈值 ${黄色阈值} 超出保证水位 ${guarantee}，按保证水位下浮 ${GUARANTEE_MARGIN}m 合并为 ${cap}`)
      yellow = cap
    }
    if (蓝色阈值 > cap) {
      notes.push(`蓝色阈值 ${蓝色阈值} 超出保证水位 ${guarantee}，按保证水位下浮 ${GUARANTEE_MARGIN}m 合并为 ${cap}`)
      blue = cap
    }
    if (blue > yellow) {
      notes.push(`蓝色阈值 ${blue} 高于合并后的黄色阈值 ${yellow}，蓝色一并调整为 ${yellow}`)
      blue = yellow
    }
  }
  const rawEffective = String(row['生效时间'] ?? '').trim()
  if (!rawEffective) {
    notes.push(`旧配置缺少生效时间，按候选生成时间 ${generatedAt} 补齐`)
  }
  return {
    监测类型: String(row['监测类型'] ?? ''),
    站点编号: stationCode,
    蓝色阈值: blue,
    黄色阈值: yellow,
    橙色阈值,
    红色阈值,
    保证水位: guarantee,
    生效时间: rawEffective || generatedAt,
    来源配置编号: String(row['配置编号'] ?? ''),
    合并说明: notes.join('；'),
  }
}

/** 值班人员从本站草稿生成候选版本：每个监测类型取最新登记的一条草稿，随后做覆盖率检查。 */
export function generateCandidate(stationCode: string, operator: string): ActionResult {
  const drafts = listRows('warning').filter(
    (row) =>
      String(row['站点编号']) === stationCode && DRAFT_STATUSES.includes(String(row.status)),
  )
  if (!drafts.length) {
    return { ok: false, message: `本站 ${stationCode} 没有可生成的草稿配置` }
  }
  const latestByType = new Map<string, EntryRow>()
  for (const row of drafts) {
    const type = String(row['监测类型'] ?? '')
    if (!type) continue
    const existing = latestByType.get(type)
    if (!existing || Number(row.id) > Number(existing.id)) {
      latestByType.set(type, row)
    }
  }
  const generatedAt = nowText()
  const guarantee = stationGuaranteeLevel(stationCode)
  const partitions: WarningPartition[] = []
  const invalidTypes: string[] = []
  for (const [type, row] of latestByType) {
    const partition = buildPartition(row, stationCode, guarantee, generatedAt)
    if (partition) {
      partitions.push(partition)
    } else {
      invalidTypes.push(type)
    }
  }
  const versions = readVersions()
  const required = requiredTypes(versions, stationCode)
  const coverage = coverageOf(partitions, required)
  const current = versions.find(
    (item) => item.status === '已发布' && item['站点编号'] === stationCode,
  )
  const id = nextVersionId(versions)
  const candidate: WarningVersion = {
    id,
    版本号: nextVersionLabel(id),
    status: '候选',
    baseVersionId: current?.id ?? null,
    站点编号: stationCode,
    操作人: operator,
    生成时间: generatedAt,
    发布时间: null,
    停用时间: null,
    覆盖要求: required,
    缺失类型: coverage.missing,
    partitions,
  }
  writeVersions([...versions, candidate])
  const invalidNote = invalidTypes.length
    ? `；监测类型 ${invalidTypes.join('、')} 的草稿阈值不是数值，已跳过`
    : ''
  return {
    ok: true,
    message: `已生成候选版本 ${candidate.版本号}，${coverage.text}${invalidNote}`,
  }
}

/**
 * 发布候选版本：先重新做覆盖率检查，再用 baseVersionId 做乐观校验——
 * 两个终端同时发布时，只有基准版本还对得上的那个候选会被接受。
 * 非本站的版本只能查看，不能从当前终端发布。
 */
export function publishCandidate(
  versionId: number,
  operator: string,
  stationCode: string,
): ActionResult {
  const versions = readVersions()
  const candidate = versions.find((item) => item.id === versionId)
  if (!candidate || candidate.status !== '候选') {
    return { ok: false, message: '候选版本不存在或已被处理，请刷新后重试' }
  }
  if (candidate['站点编号'] !== stationCode) {
    return { ok: false, message: `版本属于 ${candidate['站点编号']}，非本站配置只能查看` }
  }
  const coverage = coverageOf(candidate.partitions, requiredTypes(versions, candidate['站点编号']))
  if (!coverage.pass) {
    return { ok: false, message: `${coverage.text}，不能替换当前配置` }
  }
  const current = versions.find(
    (item) => item.status === '已发布' && item['站点编号'] === candidate['站点编号'],
  )
  if ((current?.id ?? null) !== candidate.baseVersionId) {
    return { ok: false, message: '另一个终端已发布新版本，本次发布被拒绝，请重新生成候选版本' }
  }
  const now = nowText()
  const next = versions.map((item) => {
    if (current && item.id === current.id) {
      return { ...item, status: '已停用' as const, 停用时间: now }
    }
    if (item.id === candidate.id) {
      return { ...item, status: '已发布' as const, 发布时间: now, 操作人: operator }
    }
    return item
  })
  writeVersions(next)
  return {
    ok: true,
    message: `候选版本 ${candidate.版本号} 已发布，水位预警与整编清单现在引用同一版本`,
  }
}

export function discardCandidate(versionId: number, stationCode: string): ActionResult {
  const versions = readVersions()
  const candidate = versions.find((item) => item.id === versionId)
  if (!candidate || candidate.status !== '候选') {
    return { ok: false, message: '候选版本不存在或已被处理' }
  }
  if (candidate['站点编号'] !== stationCode) {
    return { ok: false, message: `版本属于 ${candidate['站点编号']}，非本站配置只能查看` }
  }
  writeVersions(versions.filter((item) => item.id !== versionId))
  return { ok: true, message: `候选版本 ${candidate.版本号} 已作废` }
}

/** 停用当前发布版本：停用后只保留查询，不提供重新启用入口。 */
export function retirePublished(versionId: number, stationCode: string): ActionResult {
  const versions = readVersions()
  const target = versions.find((item) => item.id === versionId)
  if (!target || target.status !== '已发布') {
    return { ok: false, message: '只有已发布版本可以停用' }
  }
  if (target['站点编号'] !== stationCode) {
    return { ok: false, message: `版本属于 ${target['站点编号']}，非本站配置只能查看` }
  }
  const now = nowText()
  writeVersions(
    versions.map((item) =>
      item.id === versionId ? { ...item, status: '已停用' as const, 停用时间: now } : item,
    ),
  )
  return { ok: true, message: `版本 ${target.版本号} 已停用，仅保留查询，不能重新启用` }
}

/** 水位异常取数：按本站已发布版本的水位分区判定预警级别，不再依赖记录上的异常标记。 */
export function evaluateWaterLevel(stationCode: string, level: unknown): WaterLevelAlarm {
  const version = publishedVersionFor(stationCode)
  const partition = version?.partitions.find((item) => item.监测类型 === '水位')
  const value = toNumber(level)
  if (!version || !partition || value === null) {
    return { level: '未发布阈值', tone: 'none', version: version?.版本号 ?? null }
  }
  const reference = version.版本号
  if (value >= partition.红色阈值) return { level: '红色预警', tone: 'red', version: reference }
  if (value >= partition.橙色阈值) return { level: '橙色预警', tone: 'orange', version: reference }
  if (value >= partition.黄色阈值) return { level: '黄色预警', tone: 'yellow', version: reference }
  if (value >= partition.蓝色阈值) return { level: '蓝色预警', tone: 'blue', version: reference }
  return { level: '正常', tone: 'normal', version: reference }
}
