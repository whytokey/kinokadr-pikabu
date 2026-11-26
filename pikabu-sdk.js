/* =========================================================
   КиноКадр — фасад над Pikabu Games SDK
   ------------------------------------------------------------
   Тонкая обёртка без игровой логики: только загрузка скрипта
   платформы и вызовы PkbSDK. Вся игровая часть (паузы, начисления)
   живёт в game.js.

   Соответствие API:
     PkbSDK.init()                        → init()
     sdk.gameStarted()                    → gameStarted()
     sdk.ads.preloader|fullscreen|rewarded → ads.*
     sdk.store.getProducts|purchase|...   → store.*
     sdk.storage.get|set|flush            → storage.*
     sdk.player / sdk.auth                → player / auth
     sdk.on('userAuthorized'|'storageSaveError')
   ========================================================= */
(() => {
  'use strict';

  const SDK_URL = 'https://games.pikabu.ru/sdk/sdk.js';

  /** Таймаут инициализации: top-level (локальный просмотр) — быстро, во фрейме — терпеливо. */
  const INIT_TIMEOUT_TOP = 3000;
  const INIT_TIMEOUT_EMBEDDED = 10000;

  const noop = () => {};

  /** Ограничиваем промис по времени. */
  function withTimeout(promise, ms, message) {
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  const PkbSDK = {
    sdk: null,
    /** true — SDK Pikabu успешно инициализирован (игра работает на платформе). */
    available: false,
    /** Причина, по которой SDK не удалось поднять (null — если всё хорошо). */
    loadError: null,

    /* ---------------- ЗАГРУЗКА СКРИПТА ---------------- */
    loadScript() {
      if (this._scriptPromise) return this._scriptPromise;
      this._scriptPromise = new Promise((resolve) => {
        if (window.PkbSDK) return resolve(window.PkbSDK);
        // Тег уже есть в index.html — ждём его загрузки, не подгружая второй раз.
        const existing = document.querySelector('script[data-pkb-sdk]');
        if (existing) {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve(window.PkbSDK || null);
          };
          existing.addEventListener('load', done);
          existing.addEventListener('error', done);
          setTimeout(done, 5000); // страховка, если событие загрузки уже прошло
          return;
        }
        // Тега нет — подключаем скрипт сами (документированный способ).
        const s = document.createElement('script');
        s.src = SDK_URL;
        s.async = true;
        s.setAttribute('data-pkb-sdk', '');
        s.onload = () => resolve(window.PkbSDK || null);
        s.onerror = () => resolve(null);
        (document.head || document.documentElement).appendChild(s);
      });
      return this._scriptPromise;
    },

    /**
     * Pikabu SDK общается с платформой через postMessage родительскому фрейму.
     * Если страница открыта сама по себе (локальный просмотр, GitHub Pages без
     * платформы), «родитель» — это она сама, и SDK начинает бесконечно постить
     * самому себе "pkbsdk:ready", не получая ответа.
     * Гасим только ПОВТОРНЫЕ посты: первый должен уйти платформе как обычно.
     */
    guardSelfPost() {
      if (window.parent !== window) return;
      const orig = window.postMessage.bind(window);
      let seen = 0;
      window.postMessage = function (message, targetOrigin, transfer) {
        if (message === 'pkbsdk:ready' && targetOrigin === '*') {
          seen += 1;
          if (seen > 1) return;
        }
        return orig(message, targetOrigin, transfer);
      };
    },

    async init() {
      if (this.sdk) return this.sdk;
      this.guardSelfPost();
      const lib = await this.loadScript();
      if (!lib || typeof lib.init !== 'function') {
        this.loadError = new Error('Pikabu SDK недоступен');
        return null;
      }
      const embedded = window.parent !== window;
      const timeout = embedded ? INIT_TIMEOUT_EMBEDDED : INIT_TIMEOUT_TOP;
      try {
        this.sdk = await withTimeout(lib.init(), timeout, 'Pikabu SDK не ответил');
        this.available = !!this.sdk;
      } catch (e) {
        this.sdk = null;
        this.loadError = e;
        console.warn('[КиноКадр] Pikabu SDK недоступен — игра работает в локальном режиме:', e.message);
      }
      return this.sdk;
    },

    /** Сообщаем платформе, что игра загрузилась и готова к взаимодействию. */
    gameStarted() {
      try { this.sdk?.gameStarted?.(); } catch (e) { /* noop */ }
    },

    on(event, listener) {
      try { return this.sdk?.on?.(event, listener) || noop; } catch (e) { return noop; }
    },

    /* ---------------- РЕКЛАМА ---------------- */
    adApi(type) {
      return this.sdk?.ads?.[type] || null;
    },

    /** Поддерживается ли формат на устройстве игрока. */
    isAdSupported(type) {
      return !!this.adApi(type)?.isSupported;
    },

    /** Доступен ли показ формата прямо сейчас (нужно звать перед каждым показом). */
    async canShowAd(type) {
      const api = this.adApi(type);
      if (!api || !api.isSupported) return false;
      try { return !!(await api.canShow()); } catch (e) { return false; }
    },

    /**
     * Показ рекламы. Возвращает { rendered, reward?, reason? }.
     * rendered — окно с рекламой было показано.
     * reward — только для rewarded: пользователь досмотрел до конца.
     */
    async showAd(type) {
      const api = this.adApi(type);
      if (!api || !api.isSupported) return { rendered: false, reason: 'NOT_SUPPORTED' };
      try {
        const res = await api.show();
        return res || { rendered: false, reason: 'UNKNOWN' };
      } catch (e) {
        return { rendered: false, reason: 'UNKNOWN' };
      }
    },

    /* ---------------- МАГАЗИН ---------------- */
    async getProducts() {
      try {
        const list = await this.sdk?.store?.getProducts?.();
        return Array.isArray(list) ? list : [];
      } catch (e) { return []; }
    },

    async purchase(productId, developerPayload) {
      try {
        const res = await this.sdk?.store?.purchase?.({ productId, developerPayload });
        return res || { success: false, reason: 'UNKNOWN' };
      } catch (e) {
        return { success: false, reason: 'UNKNOWN' };
      }
    },

    async getPurchases() {
      try {
        const list = await this.sdk?.store?.getPurchases?.();
        return Array.isArray(list) ? list : [];
      } catch (e) { return []; }
    },

    async consumePurchase(purchaseId) {
      try { return (await this.sdk?.store?.consumePurchase?.(purchaseId)) || { success: false }; }
      catch (e) { return { success: false }; }
    },

    /* ---------------- ОБЛАЧНЫЕ СОХРАНЕНИЯ ---------------- */
    /** Синхронное чтение: значение уже есть в памяти SDK. */
    storageGet(key) {
      try { return this.sdk?.storage?.get?.(key); } catch (e) { return null; }
    },

    storageSet(key, value) {
      try { this.sdk?.storage?.set?.(key, value); } catch (e) { /* noop */ }
    },

    /** Явно отправляем накопленные изменения на сервер. */
    async storageFlush() {
      try { return (await this.sdk?.storage?.flush?.()) || { success: false, reason: 'UNKNOWN' }; }
      catch (e) { return { success: false, reason: 'UNKNOWN' }; }
    },

    /* ---------------- ИГРОК И АВТОРИЗАЦИЯ ---------------- */
    get player() { return this.sdk?.player || null; },

    playerName() { return this.sdk?.player?.name || ''; },

    playerAvatar() { return this.sdk?.player?.avatar || ''; },

    isAuthorized() { return !!this.sdk?.player?.isAuthorized; },

    /** Показ окна авторизации. Возвращает true, если игрок авторизован. */
    async openAuthDialog() {
      try { await this.sdk?.auth?.openAuthDialog?.(); } catch (e) { return false; }
      return this.isAuthorized();
    },
  };

  window.PikabuSDK = PkbSDK;
})();
