// 逻辑冒烟测试：模拟 localStorage，跑通 版本迁移→候选→覆盖率→并发发布→取数 全链路。
const store = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
}

import { listRows, saveRows } from '@/data/local-store'
import {
  discardCandidate,
  evaluateWaterLevel,
  generateCandidate,
  listWarningVersions,
  publishCandidate,
  publishedVersionFor,
  retirePublished,
} from '@/api/warning-service'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}`, extra ?? '')
  }
}

// 1. 旧配置兼容：已生效的 WARN-0001 缺生效时间 → 迁移成 V0 历史版本
const v0 = listWarningVersions()
check('旧配置迁移为历史发布版本', v0.length === 1 && v0[0].版本号 === 'V0-STAT-0001' && v0[0].status === '已发布', v0)
check('历史版本缺生效时间按兼容补齐', v0[0]?.partitions[0]?.生效时间 === '2000-01-01 00:00')
check('历史版本合并说明标注兼容', (v0[0]?.partitions[0]?.合并说明 ?? '').includes('缺少生效时间'))

// 2. 发布前取数：按 V0 阈值判定（蓝12/黄13/橙14/红15）
check('发布前 12.4 → 蓝色预警', evaluateWaterLevel('STAT-0001', 12.4).level === '蓝色预警')
check('发布前 13.2 → 黄色预警', evaluateWaterLevel('STAT-0001', 13.2).level === '黄色预警')
check('发布前 14.6 → 橙色预警', evaluateWaterLevel('STAT-0001', 14.6).level === '橙色预警')
check('未发布站点 → 未发布阈值', evaluateWaterLevel('STAT-0002', 99).level === '未发布阈值')

// 3. 生成候选：只收本站草稿；黄色 14.8 与保证水位 14.5 冲突 → 封顶 14.4；雨量缺生效时间 → 补齐
const gen = generateCandidate('STAT-0001', '值班管理员')
check('候选生成成功', gen.ok, gen)
const c1 = listWarningVersions().find((v) => v.status === '候选')!
check('候选覆盖 3 个监测类型', c1.缺失类型.length === 0 && c1.覆盖要求.length === 3, c1.覆盖要求)
const wl = c1.partitions.find((p) => p.监测类型 === '水位')!
check('黄色阈值按保证水位-0.1 合并', wl.黄色阈值 === 14.4, wl)
check('合并说明记录冲突处理', wl.合并说明.includes('保证水位'), wl.合并说明)
check('蓝色阈值未受影响', wl.蓝色阈值 === 12.5)
const rain = c1.partitions.find((p) => p.监测类型 === '雨量')!
check('雨量旧配置缺生效时间已补齐', rain.生效时间 === c1.生成时间 && rain.合并说明.includes('补齐'), rain)
check('非本站草稿未进入候选', !c1.partitions.some((p) => p.站点编号 === 'STAT-0002'))

// 4. 两个终端同时发布：第二个候选基于同一基准，先发布者胜
generateCandidate('STAT-0001', '另一终端')
const candidates = listWarningVersions().filter((v) => v.status === '候选')
check('两个终端各持一个候选', candidates.length === 2, candidates.map((c) => c.版本号))
const foreign = publishCandidate(candidates[0].id, '外人', 'STAT-0002')
check('非本站终端不能发布本站候选', !foreign.ok && foreign.message.includes('非本站'), foreign)
const pub1 = publishCandidate(candidates[0].id, '值班管理员', 'STAT-0001')
check('第一个候选发布成功', pub1.ok, pub1)
const pub2 = publishCandidate(candidates[1].id, '另一终端', 'STAT-0001')
check('第二个候选发布被拒绝', !pub2.ok && pub2.message.includes('另一个终端'), pub2)
const after = listWarningVersions()
check('旧版本已停用且保留查询', after.some((v) => v.版本号 === 'V0-STAT-0001' && v.status === '已停用' && v.停用时间 !== null))
check('当前发布版本是新候选', publishedVersionFor('STAT-0001')?.id === candidates[0].id)

// 5. 发布后取数：按新阈值（蓝12.5/黄14.4/橙15.5/红16.5）
check('发布后 12.4 → 正常', evaluateWaterLevel('STAT-0001', 12.4).level === '正常')
check('发布后 13.2 → 蓝色预警', evaluateWaterLevel('STAT-0001', 13.2).level === '蓝色预警')
check('发布后 14.6 → 黄色预警', evaluateWaterLevel('STAT-0001', 14.6).level === '黄色预警')
check('预警引用版本号正确', evaluateWaterLevel('STAT-0001', 14.6).version === candidates[0].版本号)

// 6. 覆盖率检查：停用流量草稿后生成候选 → 缺流量，禁止发布
const rows = listRows('warning').map((r) =>
  r['配置编号'] === 'WARN-0003' ? { ...r, status: '已停用' } : r,
)
saveRows('warning', rows)
generateCandidate('STAT-0001', '值班管理员')
const partial = listWarningVersions()
  .filter((v) => v.status === '候选')
  .sort((a, b) => b.id - a.id)[0]
check('缺流量的候选覆盖率未通过', partial.缺失类型.includes('流量'), partial.缺失类型)
const blocked = publishCandidate(partial.id, '值班管理员', 'STAT-0001')
check('覆盖率未通过不能发布', !blocked.ok && blocked.message.includes('覆盖率'), blocked)

// 7. 停用版本不能重新启用；作废候选可清理
const published = publishedVersionFor('STAT-0001')!
check('停用当前发布版本', retirePublished(published.id, 'STAT-0001').ok)
check('停用后无已发布版本', publishedVersionFor('STAT-0001') === null)
for (const leftover of listWarningVersions().filter((v) => v.status === '候选')) {
  discardCandidate(leftover.id, 'STAT-0001')
}
const ledger = listWarningVersions()
check('候选全部作废后台账只剩已停用版本', ledger.every((v) => v.status === '已停用'), ledger.map((v) => v.status))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
