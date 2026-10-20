const path = require('node:path');

const APP_NAME = 'TinadecOffice';

/**
 * The tray is owned by the main process, so its labels cannot come from the renderer bundles in
 * src/locales. This table is the whole of that copy: it carries the five interface languages the
 * renderer supports, and the renderer reports its current language over IPC (see
 * `tinadec:interface-locale`) so the menu follows a switch made in Settings.
 */
const TRAY_STRINGS = {
  'zh-CN': {
    tooltip: APP_NAME,
    show: '打开主窗口',
    hide: '隐藏窗口',
    closeToTray: '关闭窗口后保持运行',
    panels: '分离的面板',
    quit: `退出 ${APP_NAME}`,
    hiddenTitle: `${APP_NAME} 仍在运行`,
    hiddenBody: '窗口已收进托盘。点击托盘图标可重新打开，右键可退出。',
  },
  'zh-TW': {
    tooltip: APP_NAME,
    show: '開啟主視窗',
    hide: '隱藏視窗',
    closeToTray: '關閉視窗後保持執行',
    panels: '分離的面板',
    quit: `結束 ${APP_NAME}`,
    hiddenTitle: `${APP_NAME} 仍在執行`,
    hiddenBody: '視窗已收進系統匣。點擊匣圖示可重新開啟，右鍵可結束。',
  },
  en: {
    tooltip: APP_NAME,
    show: 'Open main window',
    hide: 'Hide window',
    closeToTray: 'Keep running when the window closes',
    panels: 'Detached panels',
    quit: `Quit ${APP_NAME}`,
    hiddenTitle: `${APP_NAME} is still running`,
    hiddenBody: 'The window moved to the tray. Click the tray icon to reopen it, or right-click to quit.',
  },
  ja: {
    tooltip: APP_NAME,
    show: 'メインウィンドウを開く',
    hide: 'ウィンドウを隠す',
    closeToTray: 'ウィンドウを閉じても実行を続ける',
    panels: '分離したパネル',
    quit: `${APP_NAME} を終了`,
    hiddenTitle: `${APP_NAME} は実行中です`,
    hiddenBody: 'ウィンドウはトレイに移動しました。トレイアイコンをクリックすると再表示、右クリックで終了できます。',
  },
  ru: {
    tooltip: APP_NAME,
    show: 'Открыть главное окно',
    hide: 'Скрыть окно',
    closeToTray: 'Продолжать работу после закрытия окна',
    panels: 'Откреплённые панели',
    quit: `Выйти из ${APP_NAME}`,
    hiddenTitle: `${APP_NAME} продолжает работу`,
    hiddenBody: 'Окно свёрнуто в трей. Нажмите на значок, чтобы открыть его снова, или щёлкните правой кнопкой, чтобы выйти.',
  },
};

const DEFAULT_LOCALE = 'zh-CN';

/** Map any locale tag (an OS locale, a renderer value) onto one of the five bundled languages. */
function resolveTrayLocale(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (Object.hasOwn(TRAY_STRINGS, value)) return value;
  const tag = value.toLowerCase();
  if (!tag) return DEFAULT_LOCALE;
  // Traditional Chinese scripts are tagged zh-TW/zh-HK/zh-MO, or zh-Hant-* / *-Hant.
  if (tag.startsWith('zh-tw') || tag.startsWith('zh-hk') || tag.startsWith('zh-mo') || tag.includes('hant')) return 'zh-TW';
  if (tag.startsWith('zh')) return 'zh-CN';
  if (tag.startsWith('en')) return 'en';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ru')) return 'ru';
  return DEFAULT_LOCALE;
}

function trayStrings(locale) {
  return TRAY_STRINGS[resolveTrayLocale(locale)];
}

/**
 * Windows reads the multi-size .ico; macOS and Linux want a bitmap and ignore the .ico container.
 * Both files ship in `public/` (dev) and `dist/` (packaged).
 */
function trayIconFile(platform = process.platform) {
  return platform === 'win32' ? 'tinadec.ico' : 'tinadec-logo.png';
}

/**
 * Whether closing the main window should hide it instead of tearing the app down.
 *
 * Split out of main.cjs so the rule is graded directly: hiding is only acceptable while an icon
 * exists to bring the window back, and never once quitting has started.
 */
function shouldHideOnClose({ shuttingDown, closeToTray, trayActive }) {
  return Boolean(closeToTray) && Boolean(trayActive) && !shuttingDown;
}

/**
 * Pure menu description, so the shape can be asserted without Electron.
 *
 * @param {object} options
 * @param {object} options.strings      One TRAY_STRINGS entry.
 * @param {boolean} options.visible     Whether the main window is currently on screen.
 * @param {boolean} options.closeToTray The checkbox state.
 * @param {Array<{windowId:number|string,title?:string}>} [options.panels] Detached panel windows.
 * @param {object} options.actions      show / hide / showPanel(id) / setCloseToTray(bool) / quit.
 */
function buildTrayMenuTemplate({ strings, visible, closeToTray, panels = [], actions }) {
  const template = [{ id: 'show', label: strings.show, click: () => actions.show() }];
  // Only offered while there is something to hide; a permanent item that does nothing is noise.
  if (visible) template.push({ id: 'hide', label: strings.hide, click: () => actions.hide() });
  if (panels.length > 0) {
    template.push(
      { type: 'separator' },
      {
        id: 'panels',
        label: strings.panels,
        submenu: panels.map((panel) => ({
          id: `panel:${panel.windowId}`,
          label: panel.title || String(panel.windowId),
          click: () => actions.showPanel(panel.windowId),
        })),
      },
    );
  }
  template.push(
    { type: 'separator' },
    {
      id: 'close-to-tray',
      type: 'checkbox',
      checked: Boolean(closeToTray),
      label: strings.closeToTray,
      // Electron hands the already-toggled MenuItem to `click`.
      click: (item) => actions.setCloseToTray(Boolean(item.checked)),
    },
    { type: 'separator' },
    { id: 'quit', label: strings.quit, click: () => actions.quit() },
  );
  return template;
}

/**
 * Owns the single Tray instance. Electron's classes are injected so the controller can be exercised
 * with fakes; `getState()` is the only thing the menu reads, so the caller stays the source of truth
 * for whether the window is visible, whether the preference is on, and which panels exist.
 *
 * @param {object} options
 * @param {Function} options.Tray            Electron `Tray` constructor.
 * @param {object} options.Menu              Electron `Menu` module.
 * @param {object} options.nativeImage       Electron `nativeImage` module.
 * @param {string} options.iconPath          Absolute icon path.
 * @param {string} [options.platform]        Defaults to the host platform.
 * @param {() => {enabled:boolean, visible:boolean, closeToTray:boolean, panels?:Array}} options.getState
 * @param {object} options.actions           Forwarded to the menu template.
 * @param {string} [options.locale]          Initial interface locale.
 * @param {(error: Error) => void} [options.onError] Tray construction/menu failures.
 */
function createTrayController({
  Tray,
  Menu,
  nativeImage,
  iconPath,
  platform = process.platform,
  getState,
  actions,
  locale = DEFAULT_LOCALE,
  onError = () => {},
}) {
  let tray = null;
  let currentLocale = resolveTrayLocale(locale);
  let strings = TRAY_STRINGS[currentLocale];
  // One balloon per app run: it explains the first hide, and repeating it would nag.
  let hiddenHintShown = false;

  function isActive() {
    return Boolean(tray && !tray.isDestroyed());
  }

  function buildMenu() {
    const state = getState();
    return Menu.buildFromTemplate(buildTrayMenuTemplate({
      strings,
      visible: Boolean(state.visible),
      closeToTray: Boolean(state.closeToTray),
      panels: state.panels ?? [],
      actions,
    }));
  }

  function destroy() {
    if (!tray) return;
    try { if (!tray.isDestroyed()) tray.destroy(); } catch (error) { onError(error); }
    tray = null;
  }

  /**
   * Create the icon if the preference wants one, then refresh tooltip and menu in place.
   * @returns {boolean} whether a usable tray icon exists afterwards.
   */
  function refresh() {
    if (!getState().enabled) {
      destroy();
      return false;
    }
    if (!isActive()) {
      let created;
      try {
        created = new Tray(nativeImage.createFromPath(iconPath));
      } catch (error) {
        // A desktop without a status-notifier host must not leave a hidden window with no way back;
        // the caller reads `false` and keeps the close button closing the app.
        tray = null;
        onError(error);
        return false;
      }
      tray = created;
      tray.on('click', () => actions.show());
      tray.on('double-click', () => actions.show());
    }
    try {
      tray.setToolTip(APP_NAME);
      tray.setContextMenu(buildMenu());
    } catch (error) {
      onError(error);
    }
    return true;
  }

  /** Follow the renderer's interface language; rebuilding an unchanged menu would be wasted work. */
  function setLocale(next) {
    const resolved = resolveTrayLocale(next);
    if (resolved === currentLocale) return;
    currentLocale = resolved;
    strings = TRAY_STRINGS[resolved];
    if (isActive()) refresh();
  }

  /** Explain the first hide on the one platform whose tray shows balloons. */
  function notifyHidden() {
    if (hiddenHintShown || platform !== 'win32' || !isActive()) return false;
    hiddenHintShown = true;
    try {
      tray.displayBalloon({ title: strings.hiddenTitle, content: strings.hiddenBody, iconType: 'info', noSound: true });
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  return {
    refresh,
    destroy,
    isActive,
    notifyHidden,
    setLocale,
    getLocale: () => currentLocale,
    getStrings: () => strings,
  };
}

/** Resolve the shipped icon path the same way main.cjs resolves the window icon. */
function trayIconPath({ electronDir, isDev, platform = process.platform }) {
  return path.join(electronDir, '..', isDev ? 'public' : 'dist', trayIconFile(platform));
}

module.exports = {
  APP_NAME,
  TRAY_STRINGS,
  resolveTrayLocale,
  trayStrings,
  trayIconFile,
  trayIconPath,
  shouldHideOnClose,
  buildTrayMenuTemplate,
  createTrayController,
};
