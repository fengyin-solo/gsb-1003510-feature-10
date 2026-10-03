<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">维护水位记录，围绕记录编号、站点编号、观测时间、当前水位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="refreshWarnings">按发布版本重新取数</button>
        <button class="btn" type="button" @click="openCreate">登记水位记录</button>
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
      </div>
    </header>

    <section class="warning-panel">
      <div class="warning-head">
        <h3>水位预警清单</h3>
        <span class="version-tag">
          引用阈值版本：<strong>{{ referenceVersion }}</strong>
          <template v-if="referenceTime"> · 生效时间 {{ referenceTime }}</template>
        </span>
      </div>
      <p class="warning-hint">
        预警结论只认预警阈值页面「已生效」的发布版本；草稿、候选版本、停用版本均不参与取数，整编清单引用同一版本号。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>记录编号</th><th>站点编号</th><th>观测时间</th><th>当前水位</th>
            <th>命中预警</th><th>命中阈值</th><th>引用阈值版本</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in warningRows" :key="`warn-${String(entry.row.id)}`">
            <td>{{ entry.row['记录编号'] }}</td>
            <td>{{ entry.row['站点编号'] }}</td>
            <td>{{ entry.row['观测时间'] }}</td>
            <td>{{ entry.row['当前水位'] }}</td>
            <td :class="levelClass(entry.warningLevel)">{{ entry.warningLevel }}</td>
            <td>{{ entry.matchedThreshold ?? '—' }}</td>
            <td>{{ entry.referenceVersion ?? '暂无生效版本' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无水位监测数据，可先登记水位记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水位监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  activeVersion,
  downloadEntries,
  evaluateWaterWarnings,
  listEntries,
  moduleMeta,
  refreshWaterlevelWarnings,
  runAction as applyAction,
} from '@/api/local-service'
import type { WaterWarningRow } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('waterlevel')
const columns = ["记录编号", "站点编号", "观测时间", "当前水位", "警戒水位", "保证水位", "命中预警", "引用阈值版本", "水位变幅", "记录状态"]
const actions = ["提交审核", "确认通过", "标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const stats = [{"label": "今日采集数", "value": 0}, {"label": "超警戒站次", "value": 0}, {"label": "待审核记录", "value": 0}]

const rows = ref<EntryRow[]>([])
const warningRows = ref<WaterWarningRow[]>([])
const referenceVersion = ref('暂无生效版本')
const referenceTime = ref('')
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '水位记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function levelClass(level: string): string {
  if (level.includes('红色') || level.includes('保证')) return 'level-red'
  if (level.includes('橙色')) return 'level-orange'
  if (level.includes('黄色')) return 'level-yellow'
  if (level.includes('蓝色')) return 'level-blue'
  return 'level-muted'
}

function reloadWarnings() {
  warningRows.value = evaluateWaterWarnings()
  const version = activeVersion()
  referenceVersion.value = version ? version.versionNo : '暂无生效版本'
  referenceTime.value = version?.effectiveAt ?? ''
}

function refreshWarnings() {
  const result = refreshWaterlevelWarnings()
  errorMessage.value = result.ok ? '' : result.message
  reload()
  reloadWarnings()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reloadWarnings()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '水位监测列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.warning-panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.warning-head { display: flex; justify-content: space-between; align-items: center; }
.warning-head h3 { margin: 0; font-size: 14px; }
.version-tag { font-size: 12px; color: var(--muted); }
.warning-hint { font-size: 12px; color: var(--muted); margin: 4px 0 8px; }
.level-red { color: #b42318; font-weight: 600; }
.level-orange { color: #d9730d; font-weight: 600; }
.level-yellow { color: #a16207; font-weight: 600; }
.level-blue { color: var(--brand); font-weight: 600; }
.level-muted { color: var(--muted); }
</style>
