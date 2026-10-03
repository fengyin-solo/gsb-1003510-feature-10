<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警阈值管理</h2>
        <p class="page-desc">
          阈值按监测类型分区生效：值班人员从草稿生成候选版本，覆盖率检查通过后发布替换当前配置；停用版本仅保留查询，不能重新启用。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="generate">生成候选版本</button>
        <button class="btn" type="button" @click="exportRows">导出预警阈值清单</button>
      </div>
    </header>

    <p class="info-bar">
      本站：{{ session.stationCode }}（非本站配置仅可查看） · 当前发布版本：{{ publishedLabel }}
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <h3 class="section-title">候选版本</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>版本号</th>
          <th>站点编号</th>
          <th>基准版本</th>
          <th>生成时间</th>
          <th>操作人</th>
          <th>覆盖率检查</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="item in candidates" :key="item.id">
          <tr>
            <td>{{ item.版本号 }}</td>
            <td>{{ item['站点编号'] }}</td>
            <td>{{ baseLabel(item) }}</td>
            <td>{{ item.生成时间 }}</td>
            <td>{{ item.操作人 }}</td>
            <td>
              <span :class="item.缺失类型.length ? 'error-text' : 'notice-text'">
                {{ coverageText(item) }}
              </span>
            </td>
            <td class="row-actions">
              <template v-if="item['站点编号'] === session.stationCode">
                <button
                  class="link"
                  type="button"
                  :disabled="item.缺失类型.length > 0"
                  :title="item.缺失类型.length ? '覆盖率检查未通过，不能发布' : '发布并替换当前配置'"
                  @click="publish(item)"
                >
                  发布
                </button>
                <button class="link" type="button" @click="discard(item)">作废</button>
              </template>
              <span v-else class="muted-text">仅查看（非本站）</span>
              <button class="link" type="button" @click="toggleDetail(item.id)">
                {{ expandedId === item.id ? '收起' : '查看' }}
              </button>
            </td>
          </tr>
          <tr v-if="expandedId === item.id" class="version-detail">
            <td colspan="7">
              <PartitionTable :partitions="item.partitions" />
            </td>
          </tr>
        </template>
        <tr v-if="!candidates.length">
          <td colspan="7" class="empty-state">暂无候选版本，点「生成候选版本」从本站草稿生成</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">版本台账（停用版本仅保留查询，不能重新启用）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>版本号</th>
          <th>站点编号</th>
          <th>状态</th>
          <th>生成时间</th>
          <th>发布时间</th>
          <th>停用时间</th>
          <th>操作人</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="item in ledger" :key="item.id">
          <tr>
            <td>{{ item.版本号 }}</td>
            <td>{{ item['站点编号'] }}</td>
            <td>{{ item.status }}</td>
            <td>{{ item.生成时间 }}</td>
            <td>{{ item.发布时间 ?? '—' }}</td>
            <td>{{ item.停用时间 ?? '—' }}</td>
            <td>{{ item.操作人 }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="toggleDetail(item.id)">
                {{ expandedId === item.id ? '收起' : '查看' }}
              </button>
              <button
                v-if="item.status === '已发布' && item['站点编号'] === session.stationCode"
                class="link"
                type="button"
                @click="retire(item)"
              >
                停用版本
              </button>
              <span v-if="item['站点编号'] !== session.stationCode" class="muted-text">
                仅查看（非本站）
              </span>
            </td>
          </tr>
          <tr v-if="expandedId === item.id" class="version-detail">
            <td colspan="8">
              <PartitionTable :partitions="item.partitions" />
            </td>
          </tr>
        </template>
        <tr v-if="!ledger.length">
          <td colspan="8" class="empty-state">暂无已发布或已停用版本</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">配置清单（本站草稿与已调整配置参与生成候选版本）</h3>
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
            <template v-if="session.isLocalStation(row['站点编号'])">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="muted-text">仅查看（非本站）</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无预警阈值数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警阈值记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, ref } from 'vue'
import type { PropType } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  discardCandidate,
  generateCandidate,
  listWarningVersions,
  publishCandidate,
  retirePublished,
} from '@/api/warning-service'
import type { EntryRow, WarningPartition, WarningVersion } from '@/data/types'
import { useSessionStore } from '@/stores/session'

// 版本分区的只读明细表：候选与台账里的「查看」都展开它。
const PartitionTable = defineComponent({
  props: { partitions: { type: Array as PropType<WarningPartition[]>, required: true } },
  setup(props) {
    return () =>
      h('table', { class: 'data-table partition-table' }, [
        h('thead', [
          h('tr', [
            h('th', '监测类型'),
            h('th', '蓝色阈值'),
            h('th', '黄色阈值'),
            h('th', '橙色阈值'),
            h('th', '红色阈值'),
            h('th', '保证水位'),
            h('th', '生效时间'),
            h('th', '来源配置'),
            h('th', '合并说明'),
          ]),
        ]),
        h(
          'tbody',
          props.partitions.map((p) =>
            h('tr', { key: p.监测类型 }, [
              h('td', p.监测类型),
              h('td', String(p.蓝色阈值)),
              h('td', String(p.黄色阈值)),
              h('td', String(p.橙色阈值)),
              h('td', String(p.红色阈值)),
              h('td', p.保证水位 === null ? '—' : String(p.保证水位)),
              h('td', p.生效时间),
              h('td', p.来源配置编号 || '—'),
              h('td', p.合并说明 || '—'),
            ]),
          ),
        ),
      ])
  },
})

const meta = moduleMeta('warning')
const session = useSessionStore()
const columns = ["配置编号", "站点编号", "监测类型", "蓝色阈值", "黄色阈值", "橙色阈值", "红色阈值", "生效时间", "生效状态"]
const actions = ["调整阈值", "停用配置"]
const statuses = ["草稿", "已生效", "已调整", "已停用"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const versions = ref<WarningVersion[]>([])
const expandedId = ref<number | null>(null)

const candidates = computed(() => versions.value.filter((item) => item.status === '候选'))
// 台账展示全部版本：停用版本保留查询，非本站版本也只能查看。
const ledger = computed(() => versions.value.filter((item) => item.status !== '候选'))
const published = computed(() =>
  versions.value.find(
    (item) => item.status === '已发布' && item['站点编号'] === session.stationCode,
  ),
)
const publishedLabel = computed(() => {
  const current = published.value
  return current ? `${current.版本号}（${current.发布时间} 由 ${current.操作人} 发布）` : '尚未发布'
})
const stats = computed(() => [
  { label: '草稿配置数', value: rows.value.filter((row) => ['草稿', '已调整'].includes(String(row.status))).length },
  { label: '候选版本数', value: candidates.value.length },
  { label: '当前发布版本', value: published.value?.版本号 ?? '—' },
  { label: '已停用版本数', value: ledger.value.filter((item) => item.status === '已停用').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function baseLabel(item: WarningVersion) {
  if (item.baseVersionId === null) return '—（首次发布）'
  const base = versions.value.find((version) => version.id === item.baseVersionId)
  return base ? base.版本号 : '—'
}

function coverageText(item: WarningVersion) {
  const covered = item.覆盖要求.length - item.缺失类型.length
  if (!item.缺失类型.length) {
    return `通过：已覆盖 ${covered}/${item.覆盖要求.length} 个监测类型`
  }
  return `未通过：已覆盖 ${covered}/${item.覆盖要求.length} 个监测类型，缺少 ${item.缺失类型.join('、')}`
}

function toggleDetail(id: number) {
  expandedId.value = expandedId.value === id ? null : id
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function generate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = generateCandidate(session.stationCode, session.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function publish(item: WarningVersion) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = publishCandidate(item.id, session.operator, session.stationCode)
  if (!result.ok) {
    errorMessage.value = result.message
    reload()
    return
  }
  noticeMessage.value = result.message
  reload()
}

function discard(item: WarningVersion) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = discardCandidate(item.id, session.stationCode)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function retire(item: WarningVersion) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = retirePublished(item.id, session.stationCode)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    versions.value = listWarningVersions()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警阈值列表读取失败'
  }
}

onMounted(reload)
</script>
