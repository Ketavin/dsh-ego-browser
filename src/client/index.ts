import { applyRc2 } from './rc2-client.ts'
export const name = 'ego-browser'
export const inject = ['sessions', 'connection', 'locale']
export const apply = applyRc2
