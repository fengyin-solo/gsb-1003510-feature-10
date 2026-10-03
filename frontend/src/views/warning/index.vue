<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警阈值管理</h2>
        <p class="page-desc">
          按监测类型分区生效：本站值班人员维护草稿 → 生成候选版本（覆盖率检查）→ 检查通过后替换当前配置；停用版本只保留查询。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="toggleViewpoint">
          {{ store.viewingOtherStation ? '切回本站视角' : '以他站视角查看（只读演示）' }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出预警阈值清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">当前生效版本</span>
        <strong class="stat-value">{{ active ? active.versionNo : '无生效版本' }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">生效配置项</span>
        <strong class="stat-value">{{ active ? active.items.length : 0 }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">候选版本 / 草稿</span>
        <strong class="stat-value">{{ candidate ? candidate.versionNo : '—' }} / {{ state.drafts.length }}</strong>
      </article>
    </div>

    <p class="status-tip">
      当前终端：<code>{{ state.terminalId }}</code>
      · 本站：{{ store.stationName }}（{{ store.stationCode }}）
      <span v-if="!store.canMaintainThreshold" class="error-text">· 非本站配置只能查看，不能生成候选或发布</span>
    </p>

    <!-- 当前生效版本 -->
    <section class="version-panel">
      <h3 class="panel-title">当前配置（已生效版本）</h3>
      <div v-if="active" class="version-meta">
        <span>版本号：<strong>{{ active.versionNo }}</strong></span>
        <span>生效时间：{{ active.effectiveAt }}</span>
        <span>创建人：{{ active.createdBy }}</span>
        <span>监测类型分区：{{ active.items.length }} 个站点单元</span>
        <button
          v-if="store.canMaintainThreshold"
          class="btn danger"
          type="button"
          @click="deactivate"
        >停用当前配置</button>
      </div>
      <p v-else class="empty-inline">当前没有生效版本，水位预警取数暂停；请补齐草稿后发布候选版本。</p>
    </section>

    <!-- 候选版本发布区 -->
    <section class="version-panel">
      <h3 class="panel-title">候选版本与发布</h3>

      <div class="candidate-actions">
        <button
          class="btn primary"
          type="button"
          :disabled="!store.canMaintainThreshold"
          @click="generate"
        >从草稿生成候选版本</button>
        <button class="btn" type="button" @click="simulateOtherTerminal">模拟另一终端打开（并发演示）</button>
        <span class="hint">同一时刻只接受一个候选版本；候选绑定生成终端，两个终端同时发布只有一个能成功。</span>
      </div>

      <div v-if="candidate" class="candidate-box">
        <div class="version-meta">
          <span>候选版本：<strong>{{ candidate.versionNo }}</strong></span>
          <span>基于：{{ candidate.baseVersion ?? '空版本' }}</span>
          <span>生成终端：<code>{{ candidate.terminalId }}</code></span>
          <span :class="candidate.coveragePassed ? 'ok-text' : 'error-text'">
            覆盖率检查：{{ candidate.coveragePassed ? '通过' : '未通过' }}
          </span>
        </div>

        <table class="data-table coverage-table">
          <thead>
            <tr>
              <th>监测类型分区</th><th>覆盖单元</th><th>覆盖率</th><th>缺口明细</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="zone in candidate.coverage" :key="zone.monitorType">
              <td>{{ zone.monitorType }}</td>
              <td>{{ zone.coveredCount }} / {{ zone.requiredCount }}</td>
              <td>
                <span :class="zone.missing.length === 0 ? 'ok-text' : 'error-text'">
                  {{ Math.round((zone.coveredCount / Math.max(1, zone.requiredCount)) * 100) }}%
                </span>
              </td>
              <td>
                <span v-if="zone.missing.length === 0" class="ok-text">无缺口</span>
                <ul v-else class="missing-list">
                  <li v-for="m in zone.missing" :key="m.stationCode">
                    {{ m.stationName }}（{{ m.stationCode }}）：{{ m.reason }}
                  </li>
                </ul>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="candidate.mergeNotes.length" class="notes-box">
          <p class="notes-title">合并说明（预警级别冲突取较小值、保证水位冲突取较大值，并整理为单调序列）：</p>
          <ul class="missing-list">
            <li v-for="(note, idx) in candidate.mergeNotes" :key="idx">
              [{{ note.kind }}] {{ note.stationName }} · {{ note.monitorType }}：{{ note.detail }}
            </li>
          </ul>
        </div>

        <div class="candidate-actions">
          <button
            class="btn primary"
            type="button"
            :disabled="!store.canMaintainThreshold"
            @click="publish"
          >覆盖率检查已通过，发布并替换当前配置</button>
          <button
            class="btn ghost"
            type="button"
            :disabled="!store.canMaintainThreshold"
            @click="discard"
          >作废候选版本</button>
        </div>
      </div>
      <p v-else class="empty-inline">暂无候选版本。请先在下方草稿区登记/调整本站阈值，再生成候选。</p>
    </section>

    <!-- 本站草稿 -->
    <section class="version-panel">
      <h3 class="panel-title">
        本站草稿
        <button
          class="btn primary small"
          type="button"
          :disabled="!store.canMaintainThreshold"
          @click="openDraft(null)"
        >登记本站草稿</button>
      </h3>
      <table v-if="state.drafts.length" class="data-table">
        <thead>
          <tr>
            <th>站点</th><th>监测类型</th><th>蓝色</th><th>黄色</th><th>橙色</th><th>红色</th><th>保证水位</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="draft in state.drafts" :key="draft.id">
            <td>{{ draft.stationName }}（{{ draft.stationCode }}）</td>
            <td>{{ draft.monitorType }}</td>
            <td>{{ draft.blue ?? '—' }}</td>
            <td>{{ draft.yellow ?? '—' }}</td>
            <td>{{ draft.orange ?? '—' }}</td>
            <td>{{ draft.red ?? '—' }}</td>
            <td>{{ draft.monitorType === '河道水位' ? (draft.guarantee ?? '—') : '不适用' }}</td>
            <td class="row-actions">
              <button class="link" type="button" :disabled="!store.canMaintainThreshold" @click="openDraft(draft.id)">调整阈值</button>
              <button class="link danger-link" type="button" :disabled="!store.canMaintainThreshold" @click="remove(draft.id)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-inline">暂无本站草稿。</p>
    </section>

    <!-- 配置总表 -->
    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>站点编号</span>
        <input v-model="filters['站点编号']" placeholder="按站点编号检索" />
      </label>
      <label class="filter-item">
        <span>监测类型</span>
        <input v-model="filters['监测类型']" placeholder="按监测类型检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>归属版本</th>
          <th>当前状态</th>
          <th>权限</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row['归属版本'] }}</td>
          <td>{{ row.status }}</td>
          <td>
            <span v-if="row['站点编号'] !== store.stationCode" class="readonly-tag">他站 · 只读</span>
            <span v-else class="own-tag">本站</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无预警阈值配置</td>
        </tr>
      </tbody>
    </table>

    <!-- 历史版本（停用保留查询） -->
    <section class="version-panel">
      <h3 class="panel-title">停用版本归档（仅查询，不能重新启用）</h3>
      <table v-if="archived.length" class="data-table">
        <thead>
          <tr><th>版本号</th><th>停用时间</th><th>配置单元数</th><th>停用原因</th></tr>
        </thead>
        <tbody>
          <tr v-for="version in archived" :key="version.versionNo">
            <td>{{ version.versionNo }}</td>
            <td>{{ version.effectiveAt ?? '—' }}</td>
            <td>{{ version.items.length }}</td>
            <td>{{ version.archivedReason ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-inline">暂无停用版本。</p>
    </section>

    <!-- 草稿编辑弹层 -->
    <div v-if="editing" class="modal-mask" @click.self="closeDraft">
      <div class="modal-box">
        <h3>{{ form.id ? '调整本站阈值草稿' : '登记本站阈值草稿' }}</h3>
        <p class="hint">本站：{{ store.stationName }}（{{ store.stationCode }}）；非本站配置只能在总表查看。</p>
        <div class="form-grid">
          <label>
            <span>监测类型分区 *</span>
            <select v-model="form.monitorType" :disabled="form.id !== null">
              <option v-for="t in monitorTypes" :key="t" :value="t">{{ t }}</option>
            </select>
          </label>
          <label v-for="f in levelInputs" :key="f.key">
            <span>{{ f.label }}{{ f.key === 'guarantee' && form.monitorType !== '河道水位' ? '（仅河道水位）' : '' }}</span>
            <input
              v-model="form[f.key]"
              type="number"
              step="0.01"
              :disabled="f.key === 'guarantee' && form.monitorType !== '河道水位'"
              :placeholder="`请输入${f.label}`"
            />
          </label>
        </div>
        <p v-if="draftError" class="error-text">{{ draftError }}</p>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="closeDraft">取消</button>
          <button class="btn primary" type="button" @click="saveDraft">保存草稿</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条阈值配置记录 · 发布后水位预警与整编清单统一引用同一版本号</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="infoMessage" class="ok-text">{{ infoMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

import {
  deactivateActiveVersion,
  discardCandidate,
  downloadEntries,
  generateCandidate,
  listEntries,
  listThresholdRows,
  moduleMeta,
  publishCandidate,
  removeDraft,
  switchTerminal,
  thresholdState,
  upsertDraft,
  MONITOR_TYPES,
} from '@/api/local-service'
import type {
  DraftInput,
  ThresholdItem,
  ThresholdState,
  ThresholdVersion,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const meta = moduleMeta('warning')
const columns = ["配置编号", "站点编号", "监测类型", "蓝色阈值", "黄色阈值", "橙色阈值", "红色阈值", "保证水位", "生效时间"]
const monitorTypes = [...MONITOR_TYPES]
const levelInputs = [
  { key: 'blue', label: '蓝色阈值' },
  { key: 'yellow', label: '黄色阈值' },
  { key: 'orange', label: '橙色阈值' },
  { key: 'red', label: '红色阈值' },
  { key: 'guarantee', label: '保证水位' },
] as const

// 阈值域是独立的 localStorage 数据区，这里用响应式快照驱动渲染，动作后整体刷新。
const state = reactive<ThresholdState>(thresholdState())
const rows = ref(listThresholdRows())
const total = ref(rows.value.length)
const filters = ref<Record<string, string>>({})
const errorMessage = ref('')
const infoMessage = ref('')
const draftError = ref('')

const active = computed<ThresholdVersion | null>(
  () => state.versions.find((v) => v.versionNo === state.activeVersionNo) ?? null,
)
const candidate = computed<ThresholdVersion | null>(
  () => state.versions.find((v) => v.status === '候选版本') ?? null,
)
const archived = computed<ThresholdVersion[]>(
  () => state.versions.filter((v) => v.status === '已停用'),
)
const statusSummary = computed(() =>
  ['草稿', '候选版本', '已生效', '已停用'].map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

type DraftForm = {
  id: number | null
  monitorType: string
  blue: string
  yellow: string
  orange: string
  red: string
  guarantee: string
}
const editing = ref(false)
const form = reactive<DraftForm>({
  id: null,
  monitorType: MONITOR_TYPES[0],
  blue: '',
  yellow: '',
  orange: '',
  red: '',
  guarantee: '',
})

function actor() {
  return {
    stationCode: store.stationCode,
    operator: store.operator,
    terminalId: state.terminalId,
  }
}

function syncFromDomain(message?: string, ok = true) {
  const fresh = thresholdState()
  Object.assign(state, fresh)
  const payload = listEntries(meta.key, filters.value)
  rows.value = payload.items
  total.value = payload.total
  if (message) {
    if (ok) infoMessage.value = message
    else errorMessage.value = message
  }
}

function reload() {
  errorMessage.value = ''
  syncFromDomain()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function toggleViewpoint() {
  store.setViewingOtherStation(!store.viewingOtherStation)
  reload()
}

function runDomainAction(fn: () => { ok: boolean; message: string }) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = fn()
  syncFromDomain(result.message, result.ok)
}

function generate() {
  runDomainAction(() => generateCandidate(actor()))
}

function publish() {
  runDomainAction(() => publishCandidate(actor()))
}

function discard() {
  runDomainAction(() => discardCandidate(actor()))
}

function deactivate() {
  runDomainAction(() => deactivateActiveVersion('值班人员确认停用', actor()))
}

function simulateOtherTerminal() {
  const id = switchTerminal()
  syncFromDomain(`当前终端已切换为 ${id}，再点发布将被拒绝（候选属于另一终端）`)
}

function openDraft(id: number | null) {
  draftError.value = ''
  let target: ThresholdItem | undefined
  if (id !== null) {
    target = state.drafts.find((d) => d.id === id)
    if (!target) return
  }
  form.id = target?.id ?? null
  form.monitorType = target?.monitorType ?? MONITOR_TYPES[0]
  form.blue = target?.blue?.toString() ?? ''
  form.yellow = target?.yellow?.toString() ?? ''
  form.orange = target?.orange?.toString() ?? ''
  form.red = target?.red?.toString() ?? ''
  form.guarantee = target?.guarantee?.toString() ?? ''
  editing.value = true
}

function closeDraft() {
  editing.value = false
}

function numOrNull(value: string): number | null {
  return value.trim() === '' ? null : Number(value)
}

function saveDraft() {
  draftError.value = ''
  const input: DraftInput = {
    stationCode: store.stationCode,
    monitorType: form.monitorType,
    blue: numOrNull(form.blue),
    yellow: numOrNull(form.yellow),
    orange: numOrNull(form.orange),
    red: numOrNull(form.red),
    guarantee: numOrNull(form.guarantee),
  }
  if ([input.blue, input.yellow, input.orange, input.red].some((v) => v === null)) {
    draftError.value = '四级预警阈值都需要填写（生成候选时覆盖率检查也会拦截缺级分区）'
    return
  }
  if (input.monitorType === '河道水位' && input.guarantee === null) {
    draftError.value = '河道水位分区必须填写保证水位'
    return
  }
  const values = [input.blue, input.yellow, input.orange, input.red] as number[]
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] < values[i - 1]) {
      draftError.value = '阈值需满足 蓝色 ≤ 黄色 ≤ 橙色 ≤ 红色；若历史数据逆序，生成候选时会自动修正并记录'
      return
    }
  }
  if (input.monitorType === '河道水位' && (input.guarantee as number) < (input.red as number)) {
    draftError.value = '保证水位不能低于红色阈值'
    return
  }
  const result = upsertDraft(input, { stationCode: store.stationCode }, form.id)
  if (!result.ok) {
    draftError.value = result.message
    return
  }
  editing.value = false
  syncFromDomain(result.message)
}

function remove(id: number) {
  runDomainAction(() => removeDraft(id, { stationCode: store.stationCode }))
}

// 另一终端（另一个浏览器标签页）发布后，本页重新进入时同步版本状态。
function onStorage(event: StorageEvent) {
  if (event.key === 'hydrology-monitor-station:threshold' || event.key === 'hydrology-monitor-station:entries') {
    reload()
  }
}

onMounted(() => {
  reload()
  window.addEventListener('storage', onStorage)
})
onUnmounted(() => window.removeEventListener('storage', onStorage))
</script>

<style scoped>
.status-tip { font-size: 12px; color: var(--muted); margin: 0 0 10px; }
.version-panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.panel-title { margin: 0 0 10px; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
.version-meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; align-items: center; }
.version-meta .btn { margin-left: auto; }
.candidate-actions { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.candidate-box { border-top: 1px dashed var(--border); padding-top: 10px; }
.coverage-table { margin: 8px 0; }
.missing-list { margin: 0; padding-left: 18px; }
.notes-box { background: #f8fafc; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin: 8px 0; font-size: 12px; }
.notes-title { margin: 0 0 4px; color: var(--muted); }
.hint { font-size: 12px; color: var(--muted); }
.empty-inline { color: var(--muted); font-size: 13px; margin: 4px 0; }
.ok-text { color: #067647; }
.readonly-tag { background: #f2f4f7; color: var(--muted); border-radius: 999px; padding: 2px 8px; font-size: 12px; }
.own-tag { background: #e8f1ff; color: var(--brand); border-radius: 999px; padding: 2px 8px; font-size: 12px; }
.btn.danger { border-color: #b42318; color: #b42318; }
.btn.small { padding: 3px 10px; font-size: 12px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.danger-link { color: #b42318; }
.modal-mask { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal-box { background: #fff; border-radius: 10px; padding: 18px 20px; width: 520px; max-width: 92vw; }
.modal-box h3 { margin: 0 0 6px; font-size: 15px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
.form-grid label span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.form-grid input, .form-grid select { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
