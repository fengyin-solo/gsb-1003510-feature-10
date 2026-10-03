/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 预警阈值按监测类型分区：一个版本里每个监测类型一条分区，发布时整体替换当前配置。 */
export type WarningPartition = {
  监测类型: string
  站点编号: string
  蓝色阈值: number
  黄色阈值: number
  橙色阈值: number
  红色阈值: number
  保证水位: number | null
  生效时间: string
  来源配置编号: string
  合并说明: string
}

export type WarningVersionStatus = '候选' | '已发布' | '已停用'

export type WarningVersion = {
  id: number
  版本号: string
  status: WarningVersionStatus
  /** 生成候选时看到的已发布版本 id，发布时做乐观校验：对不上说明另一个终端已抢先发布。 */
  baseVersionId: number | null
  站点编号: string
  操作人: string
  生成时间: string
  发布时间: string | null
  停用时间: string | null
  覆盖要求: string[]
  缺失类型: string[]
  partitions: WarningPartition[]
}

export type CoverageReport = {
  required: string[]
  covered: string[]
  missing: string[]
  pass: boolean
  text: string
}

/** 水位记录按已发布阈值版本判出的预警级别。 */
export type WaterLevelAlarm = {
  level: string
  tone: 'blue' | 'yellow' | 'orange' | 'red' | 'normal' | 'none'
  version: string | null
}
