(function () {
  'use strict';

  const OCR_INTERVAL_MS = 2500;

  // How many consecutive frames must produce the same code before it's
  // treated as confirmed and added to the pending list.
  const STABLE_FRAMES_REQUIRED = 3;

  // Auto-correction of common OCR letter/digit confusions is only trusted
  // when Tesseract's own confidence for the frame is at least this high.
  // A stricter bar applies when the corrected code's prefix isn't one of
  // the known ULD types below — an unfamiliar prefix needs a cleaner read.
  const CORRECTION_MIN_CONFIDENCE = 60;
  const CORRECTION_MIN_CONFIDENCE_UNKNOWN_PREFIX = 75;

  // A ULD code is always 3 letters, 5 digits, 2 letters.
  const ULD_PATTERN_TYPES = ['L', 'L', 'L', 'D', 'D', 'D', 'D', 'D', 'L', 'L'];
  const ULD_CODE_LENGTH = ULD_PATTERN_TYPES.length;

  const LETTER_FIX = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z' };
  const DIGIT_FIX = { 'O': '0', 'I': '1', 'L': '1', 'S': '5', 'B': '8', 'Z': '2' };

  const SCAN_FRAME_INSET_RATIO = 0.04;
  const OCR_MIN_WIDTH = 900;
  const DEBUG_OCR = false;

  // ---- Ops domain knowledge ----
  const STATIONS = ['KUL', 'BKI', 'KCH'];
  const FLIGHT_TYPES = ['AK', 'D7'];

  const ULD_TYPE_INFO = {
    AAY: { label: 'LD8 Container' },
    AKH: { label: 'LD3 Half Container' },
    PKC: { label: 'Pallet (PKC)' },
    AKE: { label: 'LD3 Container' },
    PMC: { label: 'Pallet 96x125 (PMC)' },
    PAG: { label: 'Pallet w/ Net (PAG)' },
    PAJ: { label: 'Pallet w/ Net (PAJ)' }
  };
  const KNOWN_ULD_PREFIXES = Object.keys(ULD_TYPE_INFO);

  const EXPECTED_ULD_DISPLAY = {
    AK: ['AAY', 'AKH', 'PKC', 'PAG/PAJ'],
    D7: ['AKE', 'PMC', 'PAG/PAJ']
  };
  const EXPECTED_PREFIXES = {
    AK: ['AAY', 'AKH', 'PKC', 'PAG', 'PAJ'],
    D7: ['AKE', 'PMC', 'PAG', 'PAJ']
  };

  const VIEWS = {
    home: { title: 'SnapULD Vision', subtitle: 'AI ULD Operations Platform', showBack: false, showStatus: false },
    scanner: { title: 'ULD Scanner', subtitle: null, showBack: true, showStatus: true },
    dashboard: { title: 'Dashboard', subtitle: 'Operational analytics', showBack: true, showStatus: false },
    history: { title: 'Scan History', subtitle: 'All scan records', showBack: true, showStatus: false },
    damage: { title: 'AI Damage Detection', subtitle: 'Future module', showBack: true, showStatus: false }
  };

  const state = {
    currentView: 'home',
    setup: { operator: '', station: null, flightType: null },
    isOnline: true,

    stream: null,
    ocrRunning: false,
    ocrTimer: null,
    ocrWorker: null,
    workerReady: false,
    audioCtx: null,

    candidateStreaks: new Map(),
    savedUlds: new Set(),
    savedCount: 0,
    pendingQueue: [],
    nextEntryId: 1,
    // per-session scan log, most recent first — resets on reload, drives the
    // Scanner page's "Scanned ULDs" list and "X scanned" session count
    scannedLog: [],
    // full persisted history across sessions — drives the Scan History page
    historyLog: [],

    historyFilters: { search: '', station: 'ALL', flightType: 'ALL', sort: 'newest' }
  };

  const HISTORY_LOG_STORAGE_KEY = 'snapuld_history_log';
  const HISTORY_LOG_MAX_ENTRIES = 500;

  const dom = {
    headerBackBtn: document.getElementById('header-back-btn'),
    headerTitle: document.getElementById('header-title'),
    headerSubtitle: document.getElementById('header-subtitle'),
    connectionStatus: document.getElementById('connection-status'),
    connectionStatusText: document.getElementById('connection-status-text'),

    views: {
      home: document.getElementById('view-home'),
      scanner: document.getElementById('view-scanner'),
      dashboard: document.getElementById('view-dashboard'),
      history: document.getElementById('view-history'),
      damage: document.getElementById('view-damage')
    },

    navScanner: document.getElementById('nav-scanner'),
    navDashboard: document.getElementById('nav-dashboard'),
    navHistory: document.getElementById('nav-history'),
    navDamage: document.getElementById('nav-damage'),

    usernameInput: document.getElementById('username-input'),
    stationSelect: document.getElementById('station-select'),
    flightTypeSelect: document.getElementById('flight-type-select'),
    expectedUldChips: document.getElementById('expected-uld-chips'),
    expectedUldHint: document.getElementById('expected-uld-hint'),
    modulesHint: document.getElementById('modules-hint'),

    contextStation: document.getElementById('context-station'),
    contextFlight: document.getElementById('context-flight'),
    contextOperator: document.getElementById('context-operator'),
    editDetailsBtn: document.getElementById('edit-details-btn'),

    video: document.getElementById('camera-video'),
    canvas: document.getElementById('capture-canvas'),
    overlayMsg: document.getElementById('camera-overlay-msg'),
    scanningBadge: document.getElementById('scanning-badge'),
    scanningBadgeText: document.getElementById('scanning-badge-text'),
    detectionStatus: document.getElementById('detection-status'),
    detectionValue: document.getElementById('detection-value'),
    candidateChips: document.getElementById('candidate-chips'),

    pendingQueueList: document.getElementById('pending-queue-list'),
    pendingCount: document.getElementById('pending-count'),
    submitQueueBtn: document.getElementById('submit-queue-btn'),

    scannedList: document.getElementById('scanned-list'),
    sessionSavedCount: document.getElementById('session-saved-count'),
    typeCountChips: document.getElementById('type-count-chips'),

    historySearch: document.getElementById('history-search'),
    historyStationFilter: document.getElementById('history-station-filter'),
    historyFlightFilter: document.getElementById('history-flight-filter'),
    historySort: document.getElementById('history-sort'),
    historyList: document.getElementById('history-list'),
    historyCount: document.getElementById('history-count'),
    exportCsvBtn: document.getElementById('export-csv-btn'),

    restartBtn: document.getElementById('restart-camera-btn'),
    toast: document.getElementById('toast')
  };

  window.addEventListener('load', init);

  function init() {
    loadHistoryLog();
    initSetupView();
    initHistoryView();
    wireNav();

    window.addEventListener('online', handleConnectivityChange);
    window.addEventListener('offline', handleConnectivityChange);
    state.isOnline = navigator.onLine;

    dom.submitQueueBtn.addEventListener('click', submitPendingQueue);
    dom.restartBtn.addEventListener('click', function () {
      stopOcrLoop();
      stopCamera();
      startCamera();
    });

    showView('home');
  }

  // ================= View router =================

  function showView(name) {
    const prev = state.currentView;
    if (prev === 'scanner' && name !== 'scanner') {
      stopOcrLoop();
      stopCamera();
    }

    Object.keys(dom.views).forEach(function (key) {
      dom.views[key].hidden = key !== name;
    });

    const cfg = VIEWS[name];
    dom.headerTitle.textContent = cfg.title;
    dom.headerSubtitle.textContent = (name === 'scanner') ? buildScannerSubtitle() : cfg.subtitle;
    dom.headerBackBtn.hidden = !cfg.showBack;
    dom.connectionStatus.hidden = !cfg.showStatus;

    state.currentView = name;

    if (name === 'scanner' && prev !== 'scanner') {
      updateContextBar();
      startCamera();
    }

    if (name === 'history') {
      renderHistoryList();
    }
  }

  function buildScannerSubtitle() {
    return (state.setup.station || '—') + ' \u00B7 ' + (state.setup.flightType || '—');
  }

  function wireNav() {
    dom.navScanner.addEventListener('click', function () { goToModule('scanner'); });
    dom.navDashboard.addEventListener('click', function () { goToModule('dashboard'); });
    dom.navHistory.addEventListener('click', function () { goToModule('history'); });
    dom.navDamage.addEventListener('click', function () { goToModule('damage'); });
    dom.headerBackBtn.addEventListener('click', function () { showView('home'); });
    dom.editDetailsBtn.addEventListener('click', function () { showView('home'); });
  }

  // Modules stay clickable even before setup is complete so a tap always
  // gives feedback — either it navigates, or it points at what's missing.
  function goToModule(name) {
    if (isSetupComplete()) {
      showView(name);
      return;
    }
    showToast('Fill in email, station & flight type first', 'info');
    focusFirstIncompleteField();
  }

  function focusFirstIncompleteField() {
    const emailOk = /\S+@\S+\.\S+/.test(state.setup.operator || '');
    let target = null;
    if (!emailOk) target = dom.usernameInput;
    else if (!state.setup.station) target = dom.stationSelect;
    else if (!state.setup.flightType) target = dom.flightTypeSelect;

    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (typeof target.focus === 'function') target.focus();
    }
  }

  function isSetupComplete() {
    const emailOk = /\S+@\S+\.\S+/.test(state.setup.operator || '');
    return !!(emailOk && state.setup.station && state.setup.flightType);
  }

  // ================= Setup view =================

  function initSetupView() {
    let savedOperator = '';
    let savedStation = null;
    let savedFlightType = null;
    try {
      savedOperator = localStorage.getItem('snapuld_operator') || '';
      savedStation = localStorage.getItem('snapuld_station');
      savedFlightType = localStorage.getItem('snapuld_flight_type');
    } catch (e) {}

    state.setup.operator = savedOperator;
    dom.usernameInput.value = savedOperator;

    const initialStation = (savedStation && STATIONS.indexOf(savedStation) !== -1) ? savedStation : null;
    state.setup.station = initialStation;
    buildChipGroup(dom.stationSelect, STATIONS, initialStation, function (value) {
      state.setup.station = value;
      try { localStorage.setItem('snapuld_station', value); } catch (e) {}
      validateSetup();
    });

    const initialFlightType = (savedFlightType && FLIGHT_TYPES.indexOf(savedFlightType) !== -1) ? savedFlightType : null;
    state.setup.flightType = initialFlightType;
    buildChipGroup(dom.flightTypeSelect, FLIGHT_TYPES, initialFlightType, function (value) {
      state.setup.flightType = value;
      try { localStorage.setItem('snapuld_flight_type', value); } catch (e) {}
      renderExpectedUldChips(value);
      validateSetup();
    });

    dom.usernameInput.addEventListener('input', function () {
      const value = dom.usernameInput.value.trim();
      state.setup.operator = value;
      try { localStorage.setItem('snapuld_operator', value); } catch (e) {}
      validateSetup();
    });

    renderExpectedUldChips(initialFlightType);
    validateSetup();
  }

  function buildChipGroup(container, options, initial, onSelect) {
    container.innerHTML = '';
    options.forEach(function (value) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'station-chip' + (value === initial ? ' active' : '');
      chip.textContent = value;
      chip.setAttribute('aria-pressed', value === initial ? 'true' : 'false');
      chip.addEventListener('click', function () {
        Array.from(container.children).forEach(function (c) {
          c.classList.remove('active');
          c.setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
        onSelect(value);
      });
      container.appendChild(chip);
    });
  }

  function renderExpectedUldChips(flightType) {
    dom.expectedUldChips.innerHTML = '';
    const list = EXPECTED_ULD_DISPLAY[flightType];
    if (!list) {
      dom.expectedUldHint.textContent = 'Select a flight type to see expected ULD prefixes.';
      return;
    }
    dom.expectedUldHint.textContent = 'Expected ULD prefixes for ' + flightType + ':';
    list.forEach(function (label) {
      const chip = document.createElement('span');
      chip.className = 'expected-uld-chip';
      chip.textContent = label;
      dom.expectedUldChips.appendChild(chip);
    });
  }

  function validateSetup() {
    const complete = isSetupComplete();

    [dom.navScanner, dom.navDashboard, dom.navHistory, dom.navDamage].forEach(function (btn) {
      btn.classList.toggle('nav-card-disabled', !complete);
      btn.setAttribute('aria-disabled', String(!complete));
    });

    dom.modulesHint.textContent = complete
      ? 'Choose a module to continue.'
      : 'Fill in email, station & flight type to unlock.';
  }

  function updateContextBar() {
    dom.contextStation.textContent = state.setup.station || '—';
    dom.contextFlight.textContent = state.setup.flightType || '—';
    dom.contextOperator.textContent = state.setup.operator || '—';
  }

  // ================= Scan History =================

  // History persists across sessions/reloads via localStorage — unlike
  // scannedLog (Scanner page, resets per session), this is the permanent
  // archive the Scan History page reads from.
  function loadHistoryLog() {
    try {
      const raw = localStorage.getItem(HISTORY_LOG_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) state.historyLog = parsed;
      }
    } catch (e) {
      console.warn('Failed to load scan history:', e);
    }
  }

  function persistHistoryLog() {
    try {
      if (state.historyLog.length > HISTORY_LOG_MAX_ENTRIES) {
        state.historyLog = state.historyLog.slice(0, HISTORY_LOG_MAX_ENTRIES);
      }
      localStorage.setItem(HISTORY_LOG_STORAGE_KEY, JSON.stringify(state.historyLog));
    } catch (e) {
      console.warn('Failed to persist scan history:', e);
    }
  }

  function initHistoryView() {
    buildChipGroup(dom.historyStationFilter, ['ALL'].concat(STATIONS), 'ALL', function (value) {
      state.historyFilters.station = value;
      renderHistoryList();
    });
    buildChipGroup(dom.historyFlightFilter, ['ALL'].concat(FLIGHT_TYPES), 'ALL', function (value) {
      state.historyFilters.flightType = value;
      renderHistoryList();
    });

    dom.historySearch.addEventListener('input', function () {
      state.historyFilters.search = dom.historySearch.value.trim().toUpperCase();
      renderHistoryList();
    });

    dom.historySort.addEventListener('change', function () {
      state.historyFilters.sort = dom.historySort.value;
      renderHistoryList();
    });

    dom.exportCsvBtn.addEventListener('click', exportHistoryCsv);
  }

  function getFilteredHistory() {
    const f = state.historyFilters;
    let list = state.historyLog.filter(function (r) {
      if (f.search && r.uld.indexOf(f.search) === -1) return false;
      if (f.station !== 'ALL' && r.station !== f.station) return false;
      if (f.flightType !== 'ALL' && r.flightType !== f.flightType) return false;
      return true;
    });

    list = list.slice();
    if (f.sort === 'oldest') {
      list.reverse();
    } else if (f.sort === 'uld-asc') {
      list.sort(function (a, b) { return a.uld.localeCompare(b.uld); });
    }
    // 'newest' matches scannedLog's natural order (unshift = most recent first)

    return list;
  }

  function renderHistoryList() {
    const list = getFilteredHistory();
    dom.historyList.innerHTML = '';
    dom.historyCount.textContent = list.length + (list.length === 1 ? ' record' : ' records');

    if (list.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'empty-hint';
      hint.textContent = state.historyLog.length === 0
        ? 'No scans recorded yet.'
        : 'No records match your search/filter.';
      dom.historyList.appendChild(hint);
      return;
    }

    list.forEach(function (record) {
      dom.historyList.appendChild(buildHistoryRow(record));
    });
  }

  function buildHistoryRow(record) {
    const row = document.createElement('div');
    row.className = 'history-row';

    const summary = document.createElement('div');
    summary.className = 'history-row-summary';

    const main = document.createElement('div');
    main.className = 'scanned-main';

    const uldLine = document.createElement('span');
    uldLine.className = 'scanned-uld';
    uldLine.textContent = record.uld;

    const subLine = document.createElement('span');
    subLine.className = 'scanned-sub';
    subLine.textContent = record.type + ' \u00B7 ' + record.station + ' \u00B7 ' + record.flightType + ' \u00B7 ' + formatTime(record.timestamp);

    main.appendChild(uldLine);
    main.appendChild(subLine);

    const badge = document.createElement('span');
    badge.className = 'badge ' + (record.syncStatus === 'synced' ? 'badge-synced' : 'badge-pending-sync');
    badge.textContent = record.syncStatus === 'synced' ? 'Synced' : 'Pending Sync';

    summary.appendChild(main);
    summary.appendChild(badge);

    const detail = document.createElement('div');
    detail.className = 'history-detail';
    detail.appendChild(buildHistoryDetailGrid(record));

    summary.addEventListener('click', function () {
      detail.classList.toggle('open');
    });

    row.appendChild(summary);
    row.appendChild(detail);
    return row;
  }

  function buildHistoryDetailGrid(record) {
    const grid = document.createElement('div');
    grid.className = 'history-detail-grid';

    const fields = [
      ['ULD Code', record.uld],
      ['Type', record.type],
      ['Expected for Flight', record.expectedMatch === false ? 'No \u2013 unexpected type' : 'Yes'],
      ['Station', record.station],
      ['Flight Type', record.flightType],
      ['Operator', record.operator],
      ['Timestamp', new Date(record.timestamp).toLocaleString()],
      ['Confidence', typeof record.confidence === 'number' ? record.confidence + '%' : '\u2014'],
      ['Location (GPS)', record.gps || 'Unavailable'],
      ['Device', record.device],
      ['Sync Status', record.syncStatus === 'synced' ? 'Synced' : 'Pending Sync']
    ];

    fields.forEach(function (pair) {
      const label = document.createElement('span');
      label.className = 'history-detail-label';
      label.textContent = pair[0];

      const value = document.createElement('span');
      value.className = 'history-detail-value';
      value.textContent = pair[1];

      grid.appendChild(label);
      grid.appendChild(value);
    });

    return grid;
  }

  function csvEscape(value) {
    const str = String(value === undefined || value === null ? '' : value);
    if (/[",\n]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function exportHistoryCsv() {
    const list = getFilteredHistory();
    if (list.length === 0) {
      showToast('No records to export', 'info');
      return;
    }

    const headers = [
      'ULD Code', 'Type', 'Expected For Flight', 'Station', 'Flight Type',
      'Operator', 'Timestamp', 'Confidence (%)', 'Location (GPS)', 'Device', 'Sync Status'
    ];

    const rows = list.map(function (r) {
      return [
        r.uld,
        r.type,
        r.expectedMatch === false ? 'No' : 'Yes',
        r.station,
        r.flightType,
        r.operator,
        r.timestamp,
        typeof r.confidence === 'number' ? r.confidence : '',
        r.gps || 'Unavailable',
        r.device,
        r.syncStatus
      ].map(csvEscape).join(',');
    });

    const csv = headers.map(csvEscape).join(',') + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'snapuld-scan-history-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(list.length + ' record' + (list.length > 1 ? 's' : '') + ' exported', 'success');
  }

  // ================= Connectivity / offline sync =================

  function handleConnectivityChange() {
    state.isOnline = navigator.onLine;
    if (state.isOnline) {
      flushOfflineQueue();
    } else if (!dom.connectionStatus.hidden) {
      setConnectionStatus(false, 'Offline \u2013 Queuing');
    }
  }

  // Records saved while offline are marked "pending sync" and kept locally;
  // there's no real backend endpoint yet, so this flips them to "synced"
  // once connectivity returns — ready to wire to a real sync call later.
  function flushOfflineQueue() {
    const pending = state.scannedLog.filter(function (r) { return r.syncStatus === 'pending'; });
    if (pending.length === 0) return;
    pending.forEach(function (r) { r.syncStatus = 'synced'; });
    persistHistoryLog();
    renderScannedList();
    if (state.currentView === 'history') renderHistoryList();
    showToast(pending.length + (pending.length > 1 ? ' records synced' : ' record synced'), 'success');
  }

  // ================= Camera =================

  function startCamera() {
    hideOverlay();
    setConnectionStatus(true, 'Camera Ready');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showOverlay('Camera Not Available');
      setConnectionStatus(false, 'No Camera API');
      return;
    }

    const constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        focusMode: 'continuous'
      },
      audio: false
    };

    navigator.mediaDevices.getUserMedia(constraints)
      .then(function (stream) {
        state.stream = stream;
        dom.video.srcObject = stream;
        return dom.video.play();
      })
      .then(function () {
        setConnectionStatus(true, 'Camera Ready');
        startOcrLoop();
      })
      .catch(function (err) {
        console.error('Camera error:', err);
        showOverlay('Kamera Tidak Dapat Diakses / Benarkan Kebenaran');
        setConnectionStatus(false, 'Camera Error');
      });
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (track) { track.stop(); });
      state.stream = null;
    }
    dom.video.srcObject = null;
  }

  function showOverlay(message) {
    dom.overlayMsg.textContent = message;
    dom.overlayMsg.classList.add('visible');
  }

  function hideOverlay() {
    dom.overlayMsg.classList.remove('visible');
  }

  function startOcrLoop() {
    stopOcrLoop();
    state.ocrTimer = setInterval(runOcrCycle, OCR_INTERVAL_MS);
    runOcrCycle();
  }

  function stopOcrLoop() {
    if (state.ocrTimer) {
      clearInterval(state.ocrTimer);
      state.ocrTimer = null;
    }
  }

  function runOcrCycle() {
    if (state.ocrRunning) return;
    if (!state.stream || dom.video.readyState < 2) return;

    state.ocrRunning = true;
    setScanningIndicator(true);

    captureFrame()
      .then(preprocessForOcr)
      .then(recognizeText)
      .then(handleOcrResult)
      .catch(function (err) {
        console.error('OCR error:', err);
        if (err && err.isEngineError) {
          setDetectionState('none', 'OCR Engine Error');
          setConnectionStatus(false, 'OCR Unavailable');
        } else {
          setDetectionState('none', 'No ULD Found');
        }
      })
      .finally(function () {
        state.ocrRunning = false;
        setScanningIndicator(false);
      });
  }

  function captureFrame() {
    return new Promise(function (resolve, reject) {
      const video = dom.video;
      if (!video.videoWidth) {
        reject(new Error('Video not ready'));
        return;
      }
      const canvas = dom.canvas;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    });
  }

  // Crop to the on-screen scan-frame area, upscale if the text is small,
  // then binarize using a per-frame Otsu threshold.
  function preprocessForOcr(sourceCanvas) {
    const fullW = sourceCanvas.width;
    const fullH = sourceCanvas.height;

    const cropX = Math.round(fullW * SCAN_FRAME_INSET_RATIO);
    const cropY = Math.round(fullH * SCAN_FRAME_INSET_RATIO);
    const cropW = fullW - cropX * 2;
    const cropH = fullH - cropY * 2;

    const scale = cropW < OCR_MIN_WIDTH ? Math.min(3, OCR_MIN_WIDTH / cropW) : 1;
    const outW = Math.round(cropW * scale);
    const outH = Math.round(cropH * scale);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext('2d');
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';

    outCtx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, outW, outH);

    const imageData = outCtx.getImageData(0, 0, outW, outH);
    const data = imageData.data;
    const grayValues = new Uint8ClampedArray(outW * outH);

    for (let p = 0; p < grayValues.length; p++) {
      const i = p * 4;
      grayValues[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }

    const threshold = computeOtsuThreshold(grayValues);

    for (let p = 0; p < grayValues.length; p++) {
      const i = p * 4;
      const value = grayValues[p] > threshold ? 255 : 0;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
    }

    outCtx.putImageData(imageData, 0, 0);

    if (DEBUG_OCR) {
      console.log('Preprocessed crop:', outW, 'x', outH, '(scale ' + scale.toFixed(2) + 'x) threshold=', threshold);
    }

    return outCanvas;
  }

  function computeOtsuThreshold(grayValues) {
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < grayValues.length; i++) {
      histogram[grayValues[i]]++;
    }

    const total = grayValues.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * histogram[t];

    let sumB = 0;
    let wB = 0;
    let maxVariance = 0;
    let threshold = 127;

    for (let t = 0; t < 256; t++) {
      wB += histogram[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;

      sumB += t * histogram[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const variance = wB * wF * (mB - mF) * (mB - mF);

      if (variance > maxVariance) {
        maxVariance = variance;
        threshold = t;
      }
    }

    return threshold;
  }

  function recognizeText(canvas) {
    setDetectionState('searching', 'Searching...');
    return getOcrWorker()
      .then(function (worker) {
        return runRecognitionPass(worker, canvas, '7').then(function (res) {
          if (res.text && res.text.trim().length > 0) return res;
          if (DEBUG_OCR) console.log('First pass empty, retrying with sparse-text mode...');
          return runRecognitionPass(worker, canvas, '11');
        });
      })
      .catch(function (err) {
        err.isEngineError = true;
        throw err;
      });
  }

  function runRecognitionPass(worker, canvas, pageSegMode) {
    return worker.setParameters({ tessedit_pageseg_mode: pageSegMode })
      .then(function () {
        return worker.recognize(canvas);
      })
      .then(function (result) {
        const text = (result && result.data && result.data.text) ? result.data.text : '';
        const confidence = (result && result.data && typeof result.data.confidence === 'number')
          ? result.data.confidence
          : 0;
        if (DEBUG_OCR) {
          console.log('Raw OCR text (PSM ' + pageSegMode + '):', JSON.stringify(text), 'confidence:', confidence);
        }
        return { text: text, confidence: confidence };
      });
  }

  function getOcrWorker() {
    if (state.ocrWorker && state.workerReady) {
      return Promise.resolve(state.ocrWorker);
    }
    if (!state.ocrWorker) {
      state.ocrWorker = Tesseract.createWorker('eng')
        .then(function (worker) {
          return worker.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
          }).then(function () {
            state.workerReady = true;
            return worker;
          });
        })
        .catch(function (err) {
          state.ocrWorker = null;
          err.isEngineError = true;
          throw err;
        });
    }
    return state.ocrWorker;
  }

  // ================= Detection / recognition =================

  function handleOcrResult(ocrResult) {
    const rawText = ocrResult.text;
    const confidence = ocrResult.confidence;
    const candidates = extractValidUldCandidates(rawText, confidence);

    if (candidates.length === 0) {
      if (DEBUG_OCR) {
        dom.detectionValue.textContent = rawText ? rawText.trim().slice(0, 40) : '(empty)';
      }
      setDetectionState('none', 'No ULD Found');
      renderCandidates([]);
      state.candidateStreaks.clear();
      return;
    }

    const seenThisFrame = new Set();
    const confirmedThisFrame = [];

    candidates.forEach(function (cand) {
      seenThisFrame.add(cand.code);
      if (isAlreadyTracked(cand.code)) return;

      const streak = (state.candidateStreaks.get(cand.code) || 0) + 1;
      state.candidateStreaks.set(cand.code, streak);

      if (streak >= STABLE_FRAMES_REQUIRED) {
        confirmedThisFrame.push(cand);
      }
    });

    Array.from(state.candidateStreaks.keys()).forEach(function (code) {
      if (!seenThisFrame.has(code)) {
        state.candidateStreaks.delete(code);
      }
    });

    confirmedThisFrame.forEach(function (cand) {
      state.candidateStreaks.delete(cand.code);
      addToPendingQueue(cand.code, cand.corrected, confidence);
    });

    const pending = candidates.filter(function (c) {
      return !isAlreadyTracked(c.code);
    });

    if (pending.length === 0) {
      if (confirmedThisFrame.length > 0) {
        setDetectionState('found', '\u2713 Added to Pending List');
      }
      return;
    }

    if (pending.length === 1) {
      const streak = state.candidateStreaks.get(pending[0].code) || STABLE_FRAMES_REQUIRED;
      setDetectionState('searching', 'Stabilizing ' + Math.min(streak, STABLE_FRAMES_REQUIRED) + '/' + STABLE_FRAMES_REQUIRED + '...');
      dom.detectionValue.textContent = pending[0].code + (pending[0].corrected ? ' (auto-corrected)' : '');
      renderCandidates([]);
      return;
    }

    setDetectionState('searching', 'Multiple ULDs \u2013 stabilizing...');
    dom.detectionValue.textContent = pending.map(function (c) { return c.code; }).join(' / ');
    renderCandidates(pending, confidence);
  }

  function isAlreadyTracked(code) {
    if (state.savedUlds.has(code)) return true;
    return state.pendingQueue.some(function (entry) { return entry.uld === code; });
  }

  function correctChar(ch, expectedType) {
    if (expectedType === 'L') {
      if (ch >= 'A' && ch <= 'Z') return { value: ch, corrected: false };
      if (LETTER_FIX[ch]) return { value: LETTER_FIX[ch], corrected: true };
      return null;
    }
    if (ch >= '0' && ch <= '9') return { value: ch, corrected: false };
    if (DIGIT_FIX[ch]) return { value: DIGIT_FIX[ch], corrected: true };
    return null;
  }

  function tryCorrectWindow(windowStr) {
    let corrected = '';
    let anyCorrection = false;

    for (let i = 0; i < ULD_CODE_LENGTH; i++) {
      const result = correctChar(windowStr[i], ULD_PATTERN_TYPES[i]);
      if (!result) return null;
      corrected += result.value;
      if (result.corrected) anyCorrection = true;
    }

    return { code: corrected, corrected: anyCorrection };
  }

  // Smart correction: regex-shaped window + position-aware letter/digit
  // fixing + confidence gating, with a stricter confidence bar when the
  // corrected prefix isn't one of the known ULD types.
  function extractValidUldCandidates(rawText, confidence) {
    if (!rawText) return [];
    const upperText = rawText.toUpperCase();
    const cleanedText = upperText.replace(/[^A-Z0-9]/g, '');

    const found = new Map();

    for (let start = 0; start <= cleanedText.length - ULD_CODE_LENGTH; start++) {
      const windowStr = cleanedText.substr(start, ULD_CODE_LENGTH);
      const result = tryCorrectWindow(windowStr);
      if (!result) continue;

      if (result.corrected) {
        const prefix = result.code.slice(0, 3);
        const knownPrefix = KNOWN_ULD_PREFIXES.indexOf(prefix) !== -1;
        const requiredConfidence = knownPrefix ? CORRECTION_MIN_CONFIDENCE : CORRECTION_MIN_CONFIDENCE_UNKNOWN_PREFIX;
        if (confidence < requiredConfidence) continue;
      }

      if (!found.has(result.code) || found.get(result.code)) {
        found.set(result.code, result.corrected);
      }
    }

    return Array.from(found.entries()).map(function (entry) {
      return { code: entry[0], corrected: entry[1] };
    });
  }

  function renderCandidates(candidates, confidence) {
    dom.candidateChips.innerHTML = '';
    candidates.forEach(function (cand) {
      const chip = document.createElement('div');
      chip.className = 'candidate-chip';
      chip.textContent = cand.code + (cand.corrected ? ' \u270e' : '');
      chip.title = cand.corrected ? 'Auto-corrected reading — tap to add to pending list' : 'Tap to add to pending list';
      chip.addEventListener('click', function () {
        addToPendingQueue(cand.code, cand.corrected, confidence);
      });
      dom.candidateChips.appendChild(chip);
    });
  }

  function setDetectionState(kind, label) {
    dom.detectionStatus.textContent = label;
    dom.detectionStatus.classList.toggle('found', kind === 'found');
    if (kind !== 'found' && !DEBUG_OCR) {
      dom.detectionValue.textContent = '\u00A0';
    }
  }

  function setScanningIndicator(isScanning) {
    dom.scanningBadge.style.display = isScanning ? 'flex' : 'none';
    dom.scanningBadgeText.textContent = isScanning ? 'Scanning' : 'Idle';
  }

  // ================= Pending queue =================

  function addToPendingQueue(code, corrected, confidence) {
    if (isAlreadyTracked(code)) return;

    const entry = {
      id: state.nextEntryId++,
      uld: code,
      corrected: !!corrected,
      confidence: typeof confidence === 'number' ? Math.round(confidence) : null
    };
    state.pendingQueue.push(entry);
    renderPendingQueue();
    playBeep();

    setDetectionState('found', '\u2713 Added to Pending List');
    dom.detectionValue.textContent = code;
    renderCandidates([]);
  }

  function renderPendingQueue() {
    dom.pendingQueueList.innerHTML = '';

    if (state.pendingQueue.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'empty-hint';
      hint.textContent = 'No scans queued yet. Detected ULDs will appear here.';
      dom.pendingQueueList.appendChild(hint);
    } else {
      state.pendingQueue.forEach(function (entry) {
        dom.pendingQueueList.appendChild(buildPendingRow(entry));
      });
    }

    dom.pendingCount.textContent = state.pendingQueue.length + ' pending';
    dom.submitQueueBtn.disabled = state.pendingQueue.length === 0;
  }

  function buildPendingRow(entry) {
    const row = document.createElement('div');
    row.className = 'pending-row';

    const wrap = document.createElement('div');
    wrap.className = 'pending-input-wrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pending-input';
    input.value = entry.uld;
    input.autocomplete = 'off';
    input.spellcheck = false;

    const meta = document.createElement('div');
    meta.className = 'pending-meta';
    updatePendingMeta(meta, entry);

    input.addEventListener('input', function () {
      entry.uld = input.value;
      updatePendingMeta(meta, entry);
    });

    wrap.appendChild(input);
    wrap.appendChild(meta);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'pending-remove-btn';
    removeBtn.setAttribute('aria-label', 'Remove from pending list');
    removeBtn.textContent = '\u2715';
    removeBtn.addEventListener('click', function () {
      state.pendingQueue = state.pendingQueue.filter(function (e) { return e.id !== entry.id; });
      renderPendingQueue();
    });

    row.appendChild(wrap);
    row.appendChild(removeBtn);
    return row;
  }

  function updatePendingMeta(metaEl, entry) {
    const code = (entry.uld || '').trim().toUpperCase();
    const info = code.length >= 3 ? ULD_TYPE_INFO[code.slice(0, 3)] : null;
    const confidenceText = (typeof entry.confidence === 'number') ? entry.confidence + '% confidence' : '';

    metaEl.innerHTML = '';
    const typeSpan = document.createElement('span');
    if (info) {
      typeSpan.className = 'type-known';
      typeSpan.textContent = info.label;
    } else {
      typeSpan.textContent = 'Type unknown';
    }
    metaEl.appendChild(typeSpan);
    if (confidenceText) {
      metaEl.appendChild(document.createTextNode(' \u00B7 ' + confidenceText));
    }
  }

  // Commits every row currently pending to the (simulated) sheet, capturing
  // full scan metadata: timestamp, operator, station, flight type, GPS,
  // device, and OCR confidence. Offline submissions are marked pending-sync
  // and flip to synced automatically once connectivity returns.
  function submitPendingQueue() {
    if (state.pendingQueue.length === 0) return;

    const toSubmit = state.pendingQueue
      .map(function (entry) {
        return { uld: (entry.uld || '').trim().toUpperCase(), confidence: entry.confidence };
      })
      .filter(function (item) { return item.uld.length > 0; });

    if (toSubmit.length === 0) return;

    setConnectionStatus(true, 'Submitting...');
    dom.submitQueueBtn.disabled = true;

    getGpsCoordinates().then(function (gps) {
      const device = getDeviceInfo();
      const timestamp = new Date().toISOString();
      const station = state.setup.station || '';
      const flightType = state.setup.flightType || '';
      const operator = state.setup.operator || 'Unknown';
      const online = navigator.onLine;

      // SIMULASI SIMPAN (Kerana GitHub Pages tiada backend DB)
      setTimeout(function () {
        toSubmit.forEach(function (item) {
          state.savedUlds.add(item.uld);
          const prefix = item.uld.slice(0, 3);
          const typeInfo = ULD_TYPE_INFO[prefix];
          const expectedList = EXPECTED_PREFIXES[flightType] || [];

          const record = {
            uld: item.uld,
            type: typeInfo ? typeInfo.label : 'Unknown',
            expectedMatch: expectedList.indexOf(prefix) !== -1,
            station: station,
            flightType: flightType,
            operator: operator,
            timestamp: timestamp,
            confidence: item.confidence,
            gps: gps,
            device: device,
            syncStatus: online ? 'synced' : 'pending'
          };

          // Same record object goes into both: scannedLog is this session's
          // view (resets on reload), historyLog is the permanent archive.
          state.scannedLog.unshift(record);
          state.historyLog.unshift(record);
        });

        persistHistoryLog();
        state.savedCount += toSubmit.length;
        updateSessionSavedCount();
        renderScannedList();
        if (state.currentView === 'history') renderHistoryList();

        state.pendingQueue = [];
        renderPendingQueue();

        setConnectionStatus(true, state.stream ? 'Camera Ready' : 'Idle');
        showToast(
          toSubmit.length + (toSubmit.length > 1 ? ' ULDs Disimpan' : ' ULD Disimpan') +
          (online ? ' (Simulasi)' : ' \u2013 Queued Offline'),
          'success'
        );
      }, 800);
    });
  }

  function getGpsCoordinates() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) { resolve('Unavailable'); return; }
      const timeout = setTimeout(function () { resolve('Unavailable'); }, 4000);
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          clearTimeout(timeout);
          resolve(pos.coords.latitude.toFixed(5) + ', ' + pos.coords.longitude.toFixed(5));
        },
        function () {
          clearTimeout(timeout);
          resolve('Unavailable');
        },
        { enableHighAccuracy: false, timeout: 3500, maximumAge: 60000 }
      );
    });
  }

  function getDeviceInfo() {
    const ua = navigator.userAgent || '';
    if (/ipad/i.test(ua)) return 'iPad';
    if (/iphone/i.test(ua)) return 'iPhone';
    if (/android/i.test(ua)) return 'Android';
    if (/windows/i.test(ua)) return 'Windows';
    if (/macintosh|mac os/i.test(ua)) return 'Mac';
    return 'Unknown Device';
  }

  function updateSessionSavedCount() {
    dom.sessionSavedCount.textContent = state.savedCount + ' scanned';
  }

  // ================= Scanned list =================

  function renderScannedList() {
    dom.scannedList.innerHTML = '';
    renderTypeCounts();

    if (state.scannedLog.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'empty-hint';
      hint.textContent = 'Nothing submitted yet this session.';
      dom.scannedList.appendChild(hint);
      return;
    }

    state.scannedLog.forEach(function (record) {
      dom.scannedList.appendChild(buildScannedRow(record));
    });
  }

  // Tally scanned ULDs by type this session (e.g. "LD3 Container: 3") so
  // ground staff can see the load-type breakdown at a glance, not just a
  // total count.
  function renderTypeCounts() {
    dom.typeCountChips.innerHTML = '';
    if (state.scannedLog.length === 0) return;

    const counts = new Map();
    state.scannedLog.forEach(function (record) {
      counts.set(record.type, (counts.get(record.type) || 0) + 1);
    });

    Array.from(counts.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .forEach(function (entry) {
        const chip = document.createElement('span');
        chip.className = 'type-count-chip';
        chip.innerHTML = entry[0] + ' <span class="count">' + entry[1] + '</span>';
        dom.typeCountChips.appendChild(chip);
      });
  }

  function buildScannedRow(record) {
    const row = document.createElement('div');
    row.className = 'scanned-row';

    const main = document.createElement('div');
    main.className = 'scanned-main';

    const uldLine = document.createElement('span');
    uldLine.className = 'scanned-uld';
    uldLine.textContent = record.uld;

    const subLine = document.createElement('span');
    subLine.className = 'scanned-sub';
    subLine.textContent = record.type + ' \u00B7 ' + formatTime(record.timestamp) +
      ' \u00B7 ' + (record.gps || 'GPS unavailable') +
      (record.expectedMatch === false ? ' \u00B7 Unexpected type' : '');

    main.appendChild(uldLine);
    main.appendChild(subLine);

    const badge = document.createElement('span');
    badge.className = 'badge ' + (record.syncStatus === 'synced' ? 'badge-synced' : 'badge-pending-sync');
    badge.textContent = record.syncStatus === 'synced' ? 'Synced' : 'Pending Sync';

    row.appendChild(main);
    row.appendChild(badge);
    return row;
  }

  function formatTime(isoString) {
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  // ================= Misc: beep, status, toast =================

  function playBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!state.audioCtx) state.audioCtx = new AudioCtx();
      const ctx = state.audioCtx;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;

      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } catch (e) {
      console.warn('Beep failed:', e);
    }
  }

  function setConnectionStatus(isOnline, label) {
    dom.connectionStatusText.textContent = label;
    dom.connectionStatus.classList.toggle('offline', !isOnline);
  }

  let toastTimer = null;
  function showToast(message, kind) {
    dom.toast.textContent = message;
    dom.toast.className = 'toast show ' + (kind || 'info');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      dom.toast.classList.remove('show');
    }, 2200);
  }

})();
