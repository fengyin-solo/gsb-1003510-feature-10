import { defineStore } from 'pinia'

// 本站：阈值配置只允许维护本站，其他站点的配置只能查看。
export const HOME_STATION = 'STAT-0001'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
    stationCode: HOME_STATION,
    stationName: '沙河闸水文站',
    // 演示用：切到「他站视角」后只能查看配置，不能生成候选版本或发布。
    viewingOtherStation: false,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    canMaintainThreshold: (state) => !state.viewingOtherStation,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setViewingOtherStation(value: boolean) {
      this.viewingOtherStation = value
      this.stationCode = value ? 'STAT-0002' : HOME_STATION
      this.stationName = value ? '柳林湾水文站' : '沙河闸水文站'
    },
  },
})
