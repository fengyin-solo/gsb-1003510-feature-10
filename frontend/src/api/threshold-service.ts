/**
 * 预警阈值版本域：按监测类型分区生效的阈值配置发布流。
 *
 * 发布链路：本站草稿 -> 生成候选版本（按分区做覆盖率检查）-> 检查通过后替换当前配置。
 * 已停用版本只保留查询，不能重新启用；候选版本绑定生成它的终端，并发发布只接受一个候选。
 * 水位预警取数与整编清单都只引用「已生效」版本，保证两边拿到的是同一个版本号。
 */
import { HOME_STATION } from '@/stores/session'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// ---- 常量 ----------------------------------------------------------------

const STORAGE_KEY = 'hydrology-monitor-station:threshold'

// 阈值按这三类监测类型分区，覆盖率检查也按分区汇总。
export const MONITOR_TYPES = ['河道水位', '河道流量', '降雨量'] as const
export const WATER_LEVEL_TYPE = '河道水位'

// 旧配置没有生效时间时的兼容起始时间。
export const LEGACY_DEFAULT_TIME = '2026-09-01 00:00'
const LEGACY_VERSION = 'V1'

const LEVEL_FIELDS = ['蓝色阈值', '黄色阈值', '橙色阈值', '红色阈值'] as const
type LevelField = (typeof LEVEL_FIELDS)[number]

// ---- 领域类型 --------------------------------------------------------------

export type ThresholdItem = {
  id: number
  stationCode: string
  stationName: string
  monitorType: string
  blue: number | null
  yellow: number | null
  orange: number | null
  red: number | null
  /** 保证水位目前只对河道水位分区有意义。 */
  guarantee: number | null
}

export type MergeNote = {
  stationCode: string
  stationName: string
  monitorType: string
  kind: '冲突合并' | '单调性修正'
  detail: string
}

export type CoverageZone = {
  monitorType: string
  requiredCount: number
  coveredCount: number
  missing: { stationCode: string; stationName: string; reason: string }[]
}

export type ThresholdVersion = {
  versionNo: string
  status: '候选版本' | '已生效' | '已停用'
  createdAt: string
  createdBy: string
  effectiveAt: string | null
  /** 候选版本基于哪个生效版本生成；发布时基线对不上就拒绝（并发保护）。 */
  baseVersion: string | null
  /** 生成候选版本的终端标识，只接受持有该标识的终端发布。 */
  terminalId: string | null
  items: ThresholdItem[]
  mergeNotes: MergeNote[]
  coverage: CoverageZone[]
  coveragePassed: boolean
  archivedReason: string | null
}

export type ThresholdState = {
  versions: ThresholdVersion[]
  drafts: ThresholdItem[]
  activeVersionNo: string | null
  seq: number
  migrated: boolean
  terminalId: string
}

// ---- 工具 -----------------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function createTerminalId(): string {
  return `TERM-${Math.random().toString(36).slice(2, 8)}`
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function cellKey(stationCode: string, monitorType: string): string {
  return `${stationCode}@@${monitorType}`
}

// 蓝/黄/橙/红取较小值（宁可早预警）；保证水位取较大值（不低于任一来源的安全上限）。
function mergeConflictingValues(
  draft: number | null,
  active: number | null,
  field: LevelField | '保证水位',
): number | null {
  if (draft === null && active === null) return null
  if (draft === null) return active
  if (active === null) return draft
  if (draft === active) return draft
  return field === '保证水位' ? Math.max(draft, active) : Math.min(draft, active)
}

/**
 * 合并同一「站点 × 监测类型」单元的多条阈值。
 * 预警级别冲突就低、保证水位冲突就高，再强制整理成 蓝<=黄<=橙<=红<=保证 的单调序列。
 */
function normalizeItem(raw: ThresholdItem, notes: MergeNote[]): ThresholdItem {
  const item = clone(raw)
  const before = {
    blue: item.blue,
    yellow: item.yellow,
    orange: item.orange,
    red: item.red,
    guarantee: item.guarantee,
  }
  const chain: { field: keyof ThresholdItem; label: string }[] = [
    { field: 'blue', label: '蓝色' },
    { field: 'yellow', label: '黄色' },
    { field: 'orange', label: '橙色' },
    { field: 'red', label: '红色' },
  ]
  // 逐级抬升：某一级比前一级低时，沿用前一级的值，保证预警强度单调。
  let prev = item.blue
  for (let i = 1; i < chain.length; i += 1) {
    const cur = item[chain[i].field] as number | null
    if (cur !== null && prev !== null && cur < prev) {
      ;(item as Record<string, unknown>)[chain[i].field] = prev
    }
    if ((item[chain[i].field] as number | null) !== null) {
      prev = item[chain[i].field] as number
    }
  }
  // 保证水位必须不低于红色阈值。
  if (item.guarantee !== null && item.red !== null && item.guarantee < item.red) {
    item.guarantee = item.red
  }
  const changed = (Object.keys(before) as (keyof typeof before)[]).some(
    (k) => before[k] !== item[k as keyof ThresholdItem],
  )
  if (changed) {
    notes.push({
      stationCode: item.stationCode,
      stationName: item.stationName,
      monitorType: item.monitorType,
      kind: '单调性修正',
      detail: `合并后存在逆序阈值，已按 蓝≤黄≤橙≤红≤保证 整理（原值 蓝${before.blue ?? '-'} 黄${before.yellow ?? '-'} 橙${before.orange ?? '-'} 红${before.red ?? '-'} 保证${before.guarantee ?? '-'}）`,
    })
  }
  return item
}

function stationNameOf(stationCode: string): string {
  const hit = listRows('station').find((row) => String(row['站点编号']) === stationCode)
  return hit ? String(hit['站点名称'] ?? stationCode) : stationCode
}

// ---- 覆盖率检查 -------------------------------------------------------------

function itemComplete(item: ThresholdItem | undefined, monitorType: string): string | null {
  if (!item) return '缺少整组阈值'
  const missingLevels = LEVEL_FIELDS.filter((f) => {
    const map = { 蓝色阈值: 'blue', 黄色阈值: 'yellow', 橙色阈值: 'orange', 红色阈值: 'red' } as const
    return item[map[f]] === null
  })
  if (missingLevels.length > 0) return `缺少${missingLevels.join('、')}`
  if (monitorType === WATER_LEVEL_TYPE && item.guarantee === null) return '缺少保证水位'
  return null
}

/**
 * 覆盖率按监测类型分区统计：当前版本已有的单元 + 本次草稿新增的单元都是必需单元，
 * 任一分区出现缺级缺项，候选版本都不允许替换当前配置。
 */
function buildCoverage(
  items: ThresholdItem[],
  requiredCells: string[],
  monitorTypes: string[],
): CoverageZone[] {
  const byCell = new Map(items.map((item) => [cellKey(item.stationCode, item.monitorType), item]))
  return monitorTypes.map((monitorType) => {
    const cells = requiredCells.filter((key) => key.endsWith(`@@${monitorType}`))
    const missing: CoverageZone['missing'] = []
    let covered = 0
    for (const key of cells) {
      const stationCode = key.split('@@')[0]
      const reason = itemComplete(byCell.get(key), monitorType)
      if (reason) {
        missing.push({ stationCode, stationName: stationNameOf(stationCode), reason })
      } else {
        covered += 1
      }
    }
    return { monitorType, requiredCount: cells.length, coveredCount: covered, missing }
  })
}

// ---- 旧配置迁移 -------------------------------------------------------------

type LegacyRow = {
  row: EntryRow
  time: string | null
}

function readLegacy(): {
  activeLike: LegacyRow[]
  stopped: LegacyRow[]
  drafts: EntryRow[]
} {
  const activeLike: LegacyRow[] = []
  const stopped: LegacyRow[] = []
  const drafts: EntryRow[] = []
  for (const row of listRows('warning')) {
    const timeRaw = row['生效时间']
    const time = typeof timeRaw === 'string' && timeRaw.trim() !== '' ? timeRaw : null
    if (row.status === '草稿') {
      drafts.push(row)
    } else if (row.status === '已停用') {
      stopped.push({ row, time })
    } else {
      // 已生效 / 已调整 都视作替换前的当前配置来源。
      activeLike.push({ row, time })
    }
  }
  return { activeLike, stopped, drafts }
}

function legacyToItem(row: EntryRow, id: number): ThresholdItem {
  const stationCode = String(row['站点编号'] ?? '')
  return {
    id,
    stationCode,
    stationName: stationNameOf(stationCode),
    monitorType: String(row['监测类型'] ?? ''),
    blue: toNumber(row['蓝色阈值']),
    yellow: toNumber(row['黄色阈值']),
    orange: toNumber(row['橙色阈值']),
    red: toNumber(row['红色阈值']),
    guarantee: toNumber(row['保证水位']),
  }
}

/**
 * 旧配置迁移：
 * - 已生效/已调整合并为 V1，同一单元多条时预警阈值就低、保证水位就高，缺生效时间补兼容起始时间；
 * - 历史停用配置保留为「已停用」版本，仅供查询；
 * - 旧草稿进入草稿区，值班人员可以继续编辑后生成候选版本。
 */
function migrate(state: ThresholdState): void {
  const { activeLike, stopped, drafts } = readLegacy()
  let seq = 0
  const nextId = () => {
    seq += 1
    return seq
  }

  // 历史停用版本（可能有多组，按时间无法区分时整体归一个 V0 归档版本）。
  if (stopped.length > 0) {
    const items = stopped.map(({ row }) => legacyToItem(row, nextId()))
    const times = stopped.map((s) => s.time).filter((t): t is string => t !== null)
    state.versions.push({
      versionNo: 'V0',
      status: '已停用',
      createdAt: times.sort()[0] ?? LEGACY_DEFAULT_TIME,
      createdBy: '历史迁移',
      effectiveAt: times.sort()[0] ?? LEGACY_DEFAULT_TIME,
      baseVersion: null,
      terminalId: null,
      items,
      mergeNotes: [],
      coverage: [],
      coveragePassed: true,
      archivedReason: '旧系统停用配置迁移保留，仅支持查询，不能重新启用',
    })
  }

  // 合并当前配置中的重复单元。
  const merged = new Map<string, ThresholdItem>()
  const mergeNotes: MergeNote[] = []
  for (const { row } of activeLike) {
    const incoming = legacyToItem(row, nextId())
    const key = cellKey(incoming.stationCode, incoming.monitorType)
    const exist = merged.get(key)
    if (!exist) {
      merged.set(key, incoming)
      continue
    }
    const fields: { field: LevelField | '保证水位'; key: keyof ThresholdItem }[] = [
      { field: '蓝色阈值', key: 'blue' },
      { field: '黄色阈值', key: 'yellow' },
      { field: '橙色阈值', key: 'orange' },
      { field: '红色阈值', key: 'red' },
      { field: '保证水位', key: 'guarantee' },
    ]
    const conflicts: string[] = []
    for (const f of fields) {
      const a = exist[f.key] as number | null
      const b = incoming[f.key] as number | null
      if (a !== null && b !== null && a !== b) {
        conflicts.push(`${f.field} ${a}/${b}`)
      }
      ;(exist as Record<string, unknown>)[f.key] = mergeConflictingValues(b, a, f.field)
    }
    if (conflicts.length > 0) {
      mergeNotes.push({
        stationCode: exist.stationCode,
        stationName: exist.stationName,
        monitorType: exist.monitorType,
        kind: '冲突合并',
        detail: `同一单元存在多条配置（${conflicts.join('，')}），预警阈值取较小值、保证水位取较大值`,
      })
    }
  }
  const v1Items = [...merged.values()].map((item) => normalizeItem(item, mergeNotes))

  const effectiveAt =
    activeLike
      .map((s) => s.time ?? LEGACY_DEFAULT_TIME)
      .sort()[0] ?? LEGACY_DEFAULT_TIME

  const requiredCells = v1Items.map((item) => cellKey(item.stationCode, item.monitorType))
  const monitorTypes = [...new Set(v1Items.map((item) => item.monitorType))]
  state.versions.push({
    versionNo: LEGACY_VERSION,
    status: '已生效',
    createdAt: effectiveAt,
    createdBy: '历史迁移',
    effectiveAt,
    baseVersion: null,
    terminalId: null,
    items: v1Items,
    mergeNotes,
    coverage: buildCoverage(v1Items, requiredCells, monitorTypes),
    coveragePassed: true,
    archivedReason: null,
  })
  state.activeVersionNo = LEGACY_VERSION

  state.drafts = drafts.map((row) => legacyToItem(row, nextId()))
  state.seq = seq
}

function persist(state: ThresholdState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

function rawState(): ThresholdState {
  const fallback: ThresholdState = {
    versions: [],
    drafts: [],
    activeVersionNo: null,
    seq: 0,
    migrated: false,
    terminalId: createTerminalId(),
  }
  if (typeof window === 'undefined' || !window.localStorage) return fallback
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return fallback
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<ThresholdState>) }
  } catch {
    return fallback
  }
}

let cache: ThresholdState | null = null

/** 读取阈值域状态；首次访问时把旧配置迁移成版本结构。 */
export function thresholdState(): ThresholdState {
  if (cache) return cache
  const state = rawState()
  if (!state.migrated) {
    migrate(state)
    state.migrated = true
    persist(state)
  }
  cache = state
  backfillLegacyReferences(state)
  return state
}

export function resetThresholdState(): ThresholdState {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY)
  }
  cache = null
  return thresholdState()
}

// 旧的水位/整编数据缺少版本引用时补当前生效版本，保证清单始终能追到版本号。
function backfillLegacyReferences(state: ThresholdState): void {
  const versionNo = state.activeVersionNo
  if (!versionNo) return
  let changed = false
  const wl = listRows('waterlevel').map((row) => {
    if (row['引用阈值版本'] === undefined || row['引用阈值版本'] === '') {
      changed = true
      return { ...row, 引用阈值版本: versionNo }
    }
    return row
  })
  if (changed) saveRows('waterlevel', wl)
  changed = false
  const cp = listRows('compilation').map((row) => {
    if (row['引用阈值版本'] === undefined || row['引用阈值版本'] === '') {
      changed = true
      return { ...row, 引用阈值版本: versionNo }
    }
    return row
  })
  if (changed) saveRows('compilation', cp)
}

// ---- 查询 ------------------------------------------------------------------

export function activeVersion(state: ThresholdState = thresholdState()): ThresholdVersion | null {
  return state.versions.find((v) => v.versionNo === state.activeVersionNo) ?? null
}

export function candidateVersion(state: ThresholdState = thresholdState()): ThresholdVersion | null {
  return state.versions.find((v) => v.status === '候选版本') ?? null
}

/** 展平成清单表格需要的行：草稿 / 候选 / 已生效 / 已停用 各自标注归属版本。 */
export function listThresholdRows(filters: Record<string, string> = {}): EntryRow[] {
  const state = thresholdState()
  const rows: EntryRow[] = []
  const push = (
    item: ThresholdItem,
    status: string,
    versionNo: string,
    effectiveAt: string | null,
    idPrefix: string,
  ) => {
    rows.push({
      id: Number(`${idPrefix}${item.id}`),
      status,
      pending: status === '草稿' || status === '候选版本',
      abnormal: status === '已停用',
      配置编号: `${item.stationCode}-${item.monitorType}`,
      站点编号: item.stationCode,
      监测类型: item.monitorType,
      蓝色阈值: item.blue ?? '',
      黄色阈值: item.yellow ?? '',
      橙色阈值: item.orange ?? '',
      红色阈值: item.red ?? '',
      保证水位: item.guarantee ?? '',
      生效时间: effectiveAt ?? '—',
      归属版本: versionNo,
    })
  }
  const candidate = candidateVersion(state)
  const active = activeVersion(state)
  for (const item of state.drafts) push(item, '草稿', '未发布', null, '1')
  if (candidate) for (const item of candidate.items) push(item, '候选版本', candidate.versionNo, null, '2')
  if (active) for (const item of active.items) push(item, '已生效', active.versionNo, active.effectiveAt, '3')
  for (const version of state.versions.filter((v) => v.status === '已停用')) {
    for (const item of version.items) push(item, '已停用', version.versionNo, version.effectiveAt, '4')
  }
  const pairs = Object.entries(filters).filter(([, v]) => v.trim() !== '')
  return pairs.length === 0
    ? rows
    : rows.filter((row) => pairs.every(([f, v]) => String(row[f] ?? '').includes(v.trim())))
}

// ---- 草稿维护（仅本站）-------------------------------------------------------

export type DraftInput = {
  stationCode: string
  monitorType: string
  blue: number | null
  yellow: number | null
  orange: number | null
  red: number | null
  guarantee: number | null
}

export function upsertDraft(
  input: DraftInput,
  actor: { stationCode: string },
  draftId: number | null = null,
): ActionResult {
  if (actor.stationCode !== HOME_STATION) {
    return { ok: false, message: '非本站配置只能查看，不能登记或调整草稿' }
  }
  if (input.stationCode !== HOME_STATION) {
    return { ok: false, message: '本站值班人员只能维护本站阈值草稿' }
  }
  if (!MONITOR_TYPES.includes(input.monitorType as (typeof MONITOR_TYPES)[number])) {
    return { ok: false, message: `监测类型必须是：${MONITOR_TYPES.join('、')}` }
  }
  const state = thresholdState()
  const existIndex = draftId
    ? state.drafts.findIndex((d) => d.id === draftId)
    : state.drafts.findIndex(
        (d) => d.stationCode === input.stationCode && d.monitorType === input.monitorType,
      )
  if (draftId && existIndex < 0) {
    return { ok: false, message: '没有找到这条草稿' }
  }
  const base = existIndex >= 0 ? state.drafts[existIndex] : null
  const item: ThresholdItem = {
    id: base?.id ?? state.seq + 1,
    stationCode: input.stationCode,
    stationName: stationNameOf(input.stationCode),
    monitorType: input.monitorType,
    blue: input.blue,
    yellow: input.yellow,
    orange: input.orange,
    red: input.red,
    guarantee: input.monitorType === WATER_LEVEL_TYPE ? input.guarantee : null,
  }
  if (base) state.drafts.splice(existIndex, 1, item)
  else {
    state.drafts.push(item)
    state.seq += 1
  }
  persist(state)
  return { ok: true, message: base ? '草稿阈值已调整' : '本站阈值草稿已登记' }
}

export function removeDraft(id: number, actor: { stationCode: string }): ActionResult {
  if (actor.stationCode !== HOME_STATION) {
    return { ok: false, message: '非本站配置只能查看，不能删除草稿' }
  }
  const state = thresholdState()
  const index = state.drafts.findIndex((d) => d.id === id)
  if (index < 0) return { ok: false, message: '没有找到这条草稿' }
  state.drafts.splice(index, 1)
  persist(state)
  return { ok: true, message: '草稿已删除' }
}

// ---- 候选版本 ---------------------------------------------------------------

/**
 * 从草稿生成候选版本：在当前生效版本之上叠加本站草稿，处理冲突合并并按分区做覆盖率检查。
 * 同时只允许存在一个候选版本。
 */
export function generateCandidate(actor: {
  stationCode: string
  operator: string
  terminalId: string
}): ActionResult {
  if (actor.stationCode !== HOME_STATION) {
    return { ok: false, message: '非本站配置只能查看，候选版本须由本站值班人员生成' }
  }
  const state = thresholdState()
  if (state.drafts.length === 0) {
    return { ok: false, message: '还没有本站草稿，请先登记或调整阈值草稿' }
  }
  if (candidateVersion(state)) {
    return { ok: false, message: '已存在候选版本，请先发布或放弃后再重新生成' }
  }
  const active = activeVersion(state)
  const notes: MergeNote[] = []
  const byCell = new Map<string, ThresholdItem>()
  for (const item of active?.items ?? []) {
    byCell.set(cellKey(item.stationCode, item.monitorType), clone(item))
  }
  let seq = state.seq
  for (const draft of state.drafts) {
    const key = cellKey(draft.stationCode, draft.monitorType)
    const exist = byCell.get(key)
    if (!exist) {
      seq += 1
      byCell.set(key, { ...clone(draft), id: seq })
      continue
    }
    const conflicts: string[] = []
    const fields: { label: string; key: keyof ThresholdItem }[] = [
      { label: '蓝色阈值', key: 'blue' },
      { label: '黄色阈值', key: 'yellow' },
      { label: '橙色阈值', key: 'orange' },
      { label: '红色阈值', key: 'red' },
      { label: '保证水位', key: 'guarantee' },
    ]
    for (const f of fields) {
      const a = exist[f.key] as number | null
      const b = draft[f.key] as number | null
      if (a !== null && b !== null && a !== b) {
        conflicts.push(`${f.label} ${a} → ${b}`)
      }
      // 草稿覆盖当前配置：以值班人员最新草稿为准；旧值为 null 时沿用当前值。
      ;(exist as Record<string, unknown>)[f.key] = b ?? a
    }
    if (conflicts.length > 0) {
      notes.push({
        stationCode: exist.stationCode,
        stationName: exist.stationName,
        monitorType: exist.monitorType,
        kind: '冲突合并',
        detail: `草稿覆盖当前配置（${conflicts.join('，')}），以值班人员最新草稿为准`,
      })
    }
  }
  state.seq = seq
  const items = [...byCell.values()].map((item) => normalizeItem(item, notes))
  const requiredCells = [
    ...new Set([
      ...(active?.items ?? []).map((i) => cellKey(i.stationCode, i.monitorType)),
      ...state.drafts.map((i) => cellKey(i.stationCode, i.monitorType)),
    ]),
  ]
  const monitorTypes = [...new Set(items.map((i) => i.monitorType))]
  const coverage = buildCoverage(items, requiredCells, monitorTypes)
  const coveragePassed = coverage.every((zone) => zone.missing.length === 0)

  const versionNo = `V${Math.max(1, ...state.versions.map((v) => Number(String(v.versionNo).slice(1)) || 0)) + 1}`
  state.versions.push({
    versionNo,
    status: '候选版本',
    createdAt: nowText(),
    createdBy: actor.operator,
    effectiveAt: null,
    baseVersion: active?.versionNo ?? null,
    terminalId: actor.terminalId,
    items,
    mergeNotes: notes,
    coverage,
    coveragePassed,
    archivedReason: null,
  })
  persist(state)
  return coveragePassed
    ? { ok: true, message: `候选版本 ${versionNo} 已生成，各监测类型分区覆盖率 100%，可以发布` }
    : {
        ok: true,
        message: `候选版本 ${versionNo} 已生成，但覆盖率检查未通过，请补齐标红分区后重新生成`,
      }
}

/** 放弃候选版本（终端不一致或值班人员主动作废时使用）。 */
export function discardCandidate(actor: { stationCode: string }): ActionResult {
  if (actor.stationCode !== HOME_STATION) {
    return { ok: false, message: '非本站配置只能查看，不能操作候选版本' }
  }
  const state = thresholdState()
  const index = state.versions.findIndex((v) => v.status === '候选版本')
  if (index < 0) return { ok: false, message: '当前没有候选版本' }
  const [removed] = state.versions.splice(index, 1)
  persist(state)
  return { ok: true, message: `候选版本 ${removed.versionNo} 已作废，可修改草稿后重新生成` }
}

function stampCompilationReferences(versionNo: string): void {
  // 发布后整编清单必须与水位预警引用同一版本：历史成果版本引用保持不动，
  // 未带引用的成果补齐为新版本。
  const rows = listRows('compilation').map((row) => ({
    ...row,
    引用阈值版本:
      row['引用阈值版本'] && row['引用阈值版本'] !== '' ? String(row['引用阈值版本']) : versionNo,
  }))
  // 整编清单中待整编/整编中的成果直接切换到新发布版本。
  const switching = rows.map((row) =>
    row.status === '待整编' || row.status === '整编中'
      ? { ...row, 引用阈值版本: versionNo }
      : row,
  )
  saveRows('compilation', switching)
}

/**
 * 发布候选版本：覆盖率通过、终端归属一致、基线仍是当前版本时才接受。
 * 两个终端同时发布时，后到者会因为终端标识/基线对不上而被拒绝。
 */
export function publishCandidate(actor: {
  stationCode: string
  operator: string
  terminalId: string
}): ActionResult {
  if (actor.stationCode !== HOME_STATION) {
    return { ok: false, message: '非本站配置只能查看，发布须由本站值班人员完成' }
  }
  const state = thresholdState()
  const candidate = candidateVersion(state)
  if (!candidate) return { ok: false, message: '当前没有候选版本，请先从草稿生成' }
  if (candidate.terminalId !== actor.terminalId) {
    return {
      ok: false,
      message: `候选版本由终端 ${candidate.terminalId} 生成，两个终端同时发布只接受一个候选，请由原终端发布或作废后重新生成`,
    }
  }
  const active = activeVersion(state)
  if (candidate.baseVersion !== (active?.versionNo ?? null)) {
    return {
      ok: false,
      message: `候选版本基于 ${candidate.baseVersion ?? '空版本'} 生成，当前配置已变更（${active?.versionNo ?? '无生效版本'}），请作废候选后重新生成`,
    }
  }
  if (!candidate.coveragePassed) {
    const zones = candidate.coverage
      .filter((z) => z.missing.length > 0)
      .map((z) => `${z.monitorType}缺 ${z.missing.length} 项`)
      .join('；')
    return { ok: false, message: `覆盖率检查未通过，不能替换当前配置：${zones}` }
  }

  // 替换当前配置：旧生效版本停用保留，候选转为生效。
  if (active) {
    active.status = '已停用'
    active.archivedReason = `被 ${candidate.versionNo} 替换，停用后仅保留查询`
  }
  candidate.status = '已生效'
  candidate.effectiveAt = nowText()
  candidate.terminalId = null
  candidate.archivedReason = null
  state.activeVersionNo = candidate.versionNo
  state.drafts = []
  stampCompilationReferences(candidate.versionNo)
  persist(state)
  return { ok: true, message: `候选版本 ${candidate.versionNo} 已发布并替换当前配置，整编清单已同步引用` }
}

/** 停用当前配置：停用版本保留查询，不能重新启用；水位预警取数将提示暂无生效版本。 */
export function deactivateActiveVersion(
  reason: string,
  actor: { stationCode: string; operator: string },
): ActionResult {
  if (actor.stationCode !== HOME_STATION) {
    return { ok: false, message: '非本站配置只能查看，不能停用配置' }
  }
  const state = thresholdState()
  const active = activeVersion(state)
  if (!active) return { ok: false, message: '当前没有已生效的阈值版本' }
  active.status = '已停用'
  active.archivedReason = `${reason || '值班人员手工停用'}；停用版本仅保留查询，不能重新启用`
  state.activeVersionNo = null
  persist(state)
  return { ok: true, message: `版本 ${active.versionNo} 已停用并保留查询，重新生效需发布新候选版本` }
}

/** 演示用：模拟换了一个终端打开系统（另一个终端并发发布的场景）。 */
export function switchTerminal(state: ThresholdState = thresholdState()): string {
  state.terminalId = createTerminalId()
  persist(state)
  return state.terminalId
}

// ---- 水位预警取数（只认发布版本）---------------------------------------------

export type WaterWarningRow = {
  row: EntryRow
  warningLevel: string
  matchedThreshold: number | null
  referenceVersion: string | null
  referenceTime: string | null
}

/**
 * 水位异常取数：严格按当前已生效版本里「河道水位」分区的阈值判定。
 * 没有生效版本或该站未配置阈值时不给预警结论，避免草稿/候选/停用版本污染取数。
 */
export function evaluateWaterWarnings(
  state: ThresholdState = thresholdState(),
): WaterWarningRow[] {
  const active = activeVersion(state)
  return listRows('waterlevel').map((row) => {
    const stationCode = String(row['站点编号'] ?? '')
    const current = toNumber(row['当前水位'])
    const item = active?.items.find(
      (i) => i.stationCode === stationCode && i.monitorType === WATER_LEVEL_TYPE,
    )
    let level = '未配置阈值'
    let matched: number | null = null
    if (active && item && current !== null) {
      if (item.guarantee !== null && current >= item.guarantee) {
        level = '超保证水位'
        matched = item.guarantee
      } else if (item.red !== null && current >= item.red) {
        level = '红色预警'
        matched = item.red
      } else if (item.orange !== null && current >= item.orange) {
        level = '橙色预警'
        matched = item.orange
      } else if (item.yellow !== null && current >= item.yellow) {
        level = '黄色预警'
        matched = item.yellow
      } else if (item.blue !== null && current >= item.blue) {
        level = '蓝色预警'
        matched = item.blue
      } else {
        level = '正常'
      }
    }
    return {
      row,
      warningLevel: active ? level : '暂无生效版本',
      matchedThreshold: matched,
      referenceVersion: active?.versionNo ?? null,
      referenceTime: active?.effectiveAt ?? null,
    }
  })
}

/** 按发布版本重新取数：把预警级别和版本号写回水位记录，异常值标记同步刷新。 */
export function refreshWaterlevelWarnings(): ActionResult {
  const state = thresholdState()
  const evaluated = evaluateWaterWarnings(state)
  const rows = evaluated.map(({ row, warningLevel, referenceVersion }) => {
    const hit = warningLevel !== '正常' && warningLevel !== '未配置阈值' && warningLevel !== '暂无生效版本'
    return {
      ...row,
      abnormal: Boolean(row.abnormal) || hit,
      命中预警: warningLevel,
      引用阈值版本: referenceVersion ?? '',
    }
  })
  saveRows('waterlevel', rows)
  const hitCount = rows.filter((r) => r['命中预警'] !== '正常').length
  const active = activeVersion(state)
  return {
    ok: true,
    message: active
      ? `已按发布版本 ${active.versionNo} 重新取数，${hitCount} 条水位记录命中预警或缺少阈值配置`
      : '当前没有生效版本，水位记录暂不能给出预警结论',
  }
}
