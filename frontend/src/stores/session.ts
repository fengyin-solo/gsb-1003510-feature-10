import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
    // 当前终端所属站点：只有本站的阈值配置可以操作，非本站配置只能查看。
    stationCode: 'STAT-0001',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    isLocalStation(code: unknown) {
      return String(code ?? '') === this.stationCode
    },
  },
})
