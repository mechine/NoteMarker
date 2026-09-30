import { defineManifest } from '@crxjs/vite-plugin'
import pkg from '../../package.json'

/** 版本号单一来源：extension/package.json（发版只改那里） */
const VERSION = pkg.version

/**
 * 权限集（specs/extension-popup 修订版 → 点击激活模型）：无 <all_urls>、无常驻 content script。
 * 划线/剪藏脚本均经 executeScript 按需注入，授权来自 activeTab（图标点击打开侧栏即激活当前页）；
 * host_permissions 仅本地后端；contextMenus 用于图标右键"同步/打开管理页"入口；
 * sidePanel 用于图标单击打开右侧标注栏（specs/extension-side-panel，剪藏入口迁至面板按钮）。
 */
export const BACKEND_ORIGIN_DEFAULT = 'http://127.0.0.1:8765'

/**
 * E2E 测试钩子：activeTab 的注入授权依赖真实用户手势（点击图标），自动化驱动拿不到。
 * 设置 NOTEMARKER_E2E_HOST=<origin> 时额外授予该测试源 host 权限；正式构建不设置，保持最小权限。
 */
const e2eExtraHosts = process.env.NOTEMARKER_E2E_HOST ? [`${process.env.NOTEMARKER_E2E_HOST}/*`] : []

export default defineManifest({
  manifest_version: 3,
  // i18n（specs extension-i18n）：文案键在 public/_locales/{en,zh_CN}/messages.json，语言跟随浏览器
  default_locale: 'en',
  name: '__MSG_extName__',
  description: '__MSG_extShortDesc__',
  version: VERSION,
  permissions: ['activeTab', 'scripting', 'storage', 'contextMenus', 'sidePanel'],
  host_permissions: [`${BACKEND_ORIGIN_DEFAULT}/*`, ...e2eExtraHosts],
  // 图标单击打开右侧标注栏（design D1）；剪藏入口迁至面板按钮
  side_panel: { default_path: 'src/views/sidepanel.html' },
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  web_accessible_resources: [
    {
      resources: ['images/*.svg'],
      matches: ['<all_urls>'],
    },
  ],
  options_page: 'src/views/options.html',
  action: {
    default_title: '__MSG_extActionTitle__',
    default_icon: {
      '16': 'icons/icon-16.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
  },
  icons: {
    '16': 'icons/icon-16.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png',
  },
})
