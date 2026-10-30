export type Status = 'scanning' | 'inactive' | 'active' | 'busy' | 'recovery' | 'conflict' | 'missing' | 'unsupported' | 'error'

export interface ViewState {
  status: Status
  title: string
  message: string
  installation?: string
  version?: string
  platform: string
  backup?: string
  progress: number
  canToggle: boolean
  action: 'activate' | 'restore' | 'locate' | 'retry'
  warnings: string[]
}

export type UpdateStatus = 'idle' | 'unconfigured' | 'development' | 'checking' | 'available' | 'current' | 'error'
export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  nextVersion?: string
  message: string
  canCheck: boolean
  canOpenRelease: boolean
}
export interface CursorZhApi {
  state(): Promise<ViewState>
  toggle(): Promise<ViewState>
  refresh(): Promise<ViewState>
  updateState(): Promise<UpdateState>
  checkUpdates(): Promise<UpdateState>
  openUpdateRelease(): Promise<UpdateState>
  onState(listener: (state: ViewState) => void): () => void
  onUpdateState(listener: (state: UpdateState) => void): () => void
}

export const CHANNEL = {
  state: 'cursorzh:state',
  toggle: 'cursorzh:toggle',
  refresh: 'cursorzh:refresh',
  updateState: 'cursorzh:update-state',
  checkUpdates: 'cursorzh:check-updates',
  openUpdateRelease: 'cursorzh:open-update-release',
  updateChanged: 'cursorzh:update-changed',
  changed: 'cursorzh:changed'
} as const
