export const PERMISSION_PRESETS = Object.freeze([
  Object.freeze({
    id: 'ask-for-approval', label: 'Ask for Approval',
    description: '工作区内读写；联网和目录外操作需批准。',
    settings: Object.freeze({ approval: 'on-request', sandbox: 'workspace-write', network: false }),
  }),
  Object.freeze({
    id: 'full-access', label: 'Full Access',
    description: '允许访问本机文件和网络，无需执行审批。',
    settings: Object.freeze({ approval: 'never', sandbox: 'none', network: true }),
  }),
  Object.freeze({
    id: 'read-only', label: 'Read-Only',
    description: '仅查看和运行受隔离的只读命令，禁止修改和提升权限。',
    settings: Object.freeze({ approval: 'never', sandbox: 'read-only', network: false }),
  }),
]);
export function permissionPreset(value) {
  const key = String(value).trim().toLowerCase().replace(/[\s_]+/g, '-');
  return PERMISSION_PRESETS.find(preset => preset.id === key || preset.label.toLowerCase().replace(/\s+/g, '-') === key);
}
export function effectivePermissions(config, selected) {
  return PERMISSION_PRESETS.find(preset => preset.id === selected)?.settings ?? config;
}
export function currentPermission(config, selected) {
  const settings = effectivePermissions(config, selected);
  return PERMISSION_PRESETS.find(preset => Object.entries(preset.settings).every(([key, value]) => settings[key] === value))
    ?? { id: 'custom', label: 'Custom', description: '使用会话配置中的审批、沙箱和网络设置。' };
}
