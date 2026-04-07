// ============================================================
//  SSVEP-BCI Communication Interface
//  Frame-accurate flickering with Unix epoch timestamping
// ============================================================

(() => {
  "use strict";

  // ── State ──────────────────────────────────────────────────
  let detectedRefreshRate = null;   // measured Hz
  let validFrequencies = [];        // factors of refresh rate / 2
  let isRunning = false;            // flicker active?
  let rafId = null;                 // requestAnimationFrame handle
  let globalFrameCount = 0;         // monotonic frame counter

  // Per-stimulus state:  { freq, k, counter, isOn, element, labelEl }
  let stimuli = [];

  // Event + frame log
  const eventLog = [];   // { type, timestamp, data }
  const frameLogs = [];  // { stimulusIndex, cycleStart: timestamp }

  // Config snapshot written on start
  let currentConfig = null;

  // ── Frame-timing diagnostics ──────────────────────────────
  let diagLastRAFTime = null;       // previous rAF timestamp (performance.now based)
  let diagFrameDeltas = [];         // recent frame deltas for rolling stats
  let diagDroppedFrames = 0;        // frames that took > 1.5× expected interval
  let diagTotalFrames = 0;
  const DIAG_REPORT_INTERVAL = 300; // log stats every N frames (~5 s at 60 Hz)

  // ── DOM refs ───────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const setupView       = $("#setup-view");
  const patientView     = $("#patient-view");
  const detectedHzEl    = $("#detected-hz");
  const validFreqsEl    = $("#valid-freqs");
  const questionInput   = $("#question-input");
  const numOptionsSelect = $("#num-options");
  const optionsContainer = $("#options-container");
  const startBtn        = $("#start-btn");
  const validationMsg   = $("#validation-msg");
  const backBtn         = $("#back-btn");
  const playPauseBtn    = $("#play-pause-btn");
  const downloadLogBtn  = $("#download-log-btn");
  const patientQuestion = $("#patient-question");
  const stimulusArea    = $("#stimulus-area");
  const syncSquare      = $("#sync-square");
  const syncToggle      = $("#sync-square-toggle");

  // ── Refresh Rate Detection ─────────────────────────────────
  // Measures actual monitor refresh rate by timing rAF callbacks.
  function detectRefreshRate() {
    return new Promise((resolve) => {
      const samples = [];
      let prev = null;
      let count = 0;
      const TARGET = 120; // frames to sample

      function tick(ts) {
        if (prev !== null) {
          samples.push(ts - prev);
        }
        prev = ts;
        count++;
        if (count < TARGET) {
          requestAnimationFrame(tick);
        } else {
          // Median delta → Hz, rounded to nearest common rate
          samples.sort((a, b) => a - b);
          const median = samples[Math.floor(samples.length / 2)];
          const rawHz = 1000 / median;
          // Snap to nearest standard rate
          const standard = [60, 72, 75, 90, 100, 120, 144, 165, 180, 240, 360];
          let best = standard[0];
          for (const r of standard) {
            if (Math.abs(r - rawHz) < Math.abs(best - rawHz)) best = r;
          }
          resolve(best);
        }
      }
      requestAnimationFrame(tick);
    });
  }

  // Compute valid SSVEP frequencies for a given refresh rate.
  // A frequency f is valid when R/(2f) is an integer ≥ 1.
  function computeValidFrequencies(R) {
    const freqs = [];
    for (let k = 1; k <= R / 2; k++) {
      const f = R / (2 * k);
      // Keep frequencies that are "nice" (at most 1 decimal)
      if (f >= 1 && (f === Math.floor(f) || (f * 10) === Math.floor(f * 10))) {
        freqs.push(f);
      }
    }
    // Deduplicate & sort descending
    return [...new Set(freqs)].sort((a, b) => b - a);
  }

  // ── Option Row Builder ─────────────────────────────────────
  function buildOptionRows() {
    const n = parseInt(numOptionsSelect.value, 10);
    optionsContainer.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const row = document.createElement("div");
      row.className = "flex gap-3 items-end";
      row.innerHTML = `
        <div class="flex-1">
          <label class="block mb-1 text-xs text-gray-400">Option ${i + 1} Label</label>
          <input type="text" data-label="${i}" placeholder="e.g. Yes"
            class="option-label w-full p-2 rounded-lg bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm" />
        </div>
        <div class="w-40">
          <label class="block mb-1 text-xs text-gray-400">Frequency (Hz)</label>
          <select data-freq="${i}"
            class="option-freq w-full p-2 rounded-lg bg-gray-800 border border-gray-700 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm">
            ${validFrequencies.map(f => `<option value="${f}">${f} Hz</option>`).join("")}
          </select>
        </div>
      `;
      optionsContainer.appendChild(row);
    }
    // Auto-assign distinct default frequencies
    const freqSelects = optionsContainer.querySelectorAll(".option-freq");
    freqSelects.forEach((sel, i) => {
      if (validFrequencies[i] !== undefined) {
        sel.value = validFrequencies[i];
      }
    });
    validate();
  }

  // ── Validation ─────────────────────────────────────────────
  function validate() {
    const q = questionInput.value.trim();
    const labels = [...optionsContainer.querySelectorAll(".option-label")].map(el => el.value.trim());
    const freqs  = [...optionsContainer.querySelectorAll(".option-freq")].map(el => parseFloat(el.value));

    let msg = "";
    if (!q) msg = "Enter a question.";
    else if (labels.some(l => !l)) msg = "All option labels are required.";
    else {
      // Check for duplicate frequencies
      const freqSet = new Set(freqs);
      if (freqSet.size !== freqs.length) msg = "Each option must have a unique frequency.";
    }

    validationMsg.textContent = msg;
    validationMsg.classList.toggle("hidden", !msg);
    startBtn.disabled = !!msg;
    return !msg;
  }

  // ── Build Stimulus DOM ─────────────────────────────────────
  function buildStimulusView(config) {
    patientQuestion.textContent = config.question;
    stimulusArea.innerHTML = "";
    stimuli = [];

    const n = config.options.length;
    // Grid layout: 1 col for 1, 2 cols for 2-4, 3 cols for 5-6, etc.
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    stimulusArea.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    stimulusArea.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    config.options.forEach((opt, i) => {
      const wrapper = document.createElement("div");
      wrapper.className = "flex flex-col items-center justify-center gap-2 min-h-0";

      const block = document.createElement("div");
      block.className = `stimulus-block rounded-2xl stimulus-off flex items-center justify-center w-full h-full`;
      block.style.border = "3px solid #333";
      block.style.maxHeight = "100%";

      const label = document.createElement("span");
      label.className = "text-white text-5xl font-bold pointer-events-none select-none";
      label.textContent = opt.label;
      block.appendChild(label);

      const freqTag = document.createElement("span");
      freqTag.className = "text-gray-500 text-xs font-mono";
      freqTag.textContent = `${opt.freq} Hz`;

      wrapper.style.minHeight = "0";
      wrapper.appendChild(block);
      wrapper.appendChild(freqTag);
      stimulusArea.appendChild(wrapper);

      const k = detectedRefreshRate / (2 * opt.freq);
      stimuli.push({
        freq: opt.freq,
        k: Math.round(k),
        counter: 0,
        isOn: false,
        element: block,
        labelEl: label,
      });
    });

    // Sync square visibility
    syncSquare.classList.toggle("hidden", !config.syncSquare);
  }

  // ── Flicker Loop ───────────────────────────────────────────
  function flickerLoop(rafTimestamp) {
    const ts = Date.now();
    globalFrameCount++;

    // ── Frame-timing diagnostics ──
    if (diagLastRAFTime !== null) {
      const delta = rafTimestamp - diagLastRAFTime;
      diagFrameDeltas.push(delta);
      diagTotalFrames++;
      const expectedInterval = 1000 / detectedRefreshRate;
      if (delta > expectedInterval * 1.5) {
        diagDroppedFrames++;
        console.warn(`[SSVEP] Dropped frame #${globalFrameCount}: delta=${delta.toFixed(2)}ms (expected ~${expectedInterval.toFixed(1)}ms)`);
      }
      if (diagFrameDeltas.length >= DIAG_REPORT_INTERVAL) {
        const sorted = [...diagFrameDeltas].sort((a, b) => a - b);
        const min = sorted[0].toFixed(2);
        const max = sorted[sorted.length - 1].toFixed(2);
        const median = sorted[Math.floor(sorted.length / 2)].toFixed(2);
        const mean = (diagFrameDeltas.reduce((a, b) => a + b, 0) / diagFrameDeltas.length).toFixed(2);
        const jitter = (Math.sqrt(diagFrameDeltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / diagFrameDeltas.length)).toFixed(2);
        console.log(
          `[SSVEP] Frame stats (last ${DIAG_REPORT_INTERVAL} frames): ` +
          `min=${min}ms  median=${median}ms  mean=${mean}ms  max=${max}ms  jitter(σ)=${jitter}ms  ` +
          `dropped=${diagDroppedFrames}/${diagTotalFrames} total`
        );
        diagFrameDeltas = [];
      }
    }
    diagLastRAFTime = rafTimestamp;

    stimuli.forEach((s, idx) => {
      s.counter++;
      if (s.counter >= s.k) {
        s.counter = 0;
        s.isOn = !s.isOn;
        if (s.isOn) {
          s.element.classList.replace("stimulus-off", "stimulus-on");
          s.labelEl.style.color = "#000";
          // Log cycle-start (first ON frame)
          frameLogs.push({ stimulusIndex: idx, freq: s.freq, timestamp: ts, frame: globalFrameCount });
        } else {
          s.element.classList.replace("stimulus-on", "stimulus-off");
          s.labelEl.style.color = "#FFF";
        }
      }
    });

    // Sync square follows stimulus 0
    if (currentConfig && currentConfig.syncSquare && stimuli.length > 0) {
      const s0 = stimuli[0];
      if (s0.isOn) {
        syncSquare.classList.replace("sync-off", "sync-on");
      } else {
        syncSquare.classList.replace("sync-on", "sync-off");
      }
    }

    rafId = requestAnimationFrame(flickerLoop);
  }

  function startFlicker() {
    if (isRunning) return;
    isRunning = true;
    globalFrameCount = 0;
    diagLastRAFTime = null;
    diagFrameDeltas = [];
    diagDroppedFrames = 0;
    diagTotalFrames = 0;
    // Reset per-stimulus counters
    stimuli.forEach(s => { s.counter = 0; s.isOn = false; });
    logEvent("play", { timestamp: Date.now() });
    playPauseBtn.textContent = "⏸ Pause";
    playPauseBtn.classList.replace("bg-green-600", "bg-red-600");
    playPauseBtn.classList.replace("hover:bg-green-500", "hover:bg-red-500");
    rafId = requestAnimationFrame(flickerLoop);
  }

  function stopFlicker() {
    if (!isRunning) return;
    isRunning = false;
    cancelAnimationFrame(rafId);
    rafId = null;
    logEvent("pause", { timestamp: Date.now() });
    playPauseBtn.textContent = "▶ Play";
    playPauseBtn.classList.replace("bg-red-600", "bg-green-600");
    playPauseBtn.classList.replace("hover:bg-red-500", "hover:bg-green-500");
    // Turn all stimuli off
    stimuli.forEach(s => {
      s.isOn = false;
      s.element.classList.replace("stimulus-on", "stimulus-off");
      s.labelEl.style.color = "#FFF";
    });
    syncSquare.classList.replace("sync-on", "sync-off");
  }

  // ── Event Logging ──────────────────────────────────────────
  function logEvent(type, data = {}) {
    eventLog.push({
      type,
      timestamp: Date.now(),
      ...data,
    });
  }

  function downloadLog() {
    const payload = {
      config: currentConfig,
      refreshRate: detectedRefreshRate,
      events: eventLog,
      frameCycleLogs: frameLogs,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ssvep-log-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── View Transitions ───────────────────────────────────────
  function showPatientView() {
    if (!validate()) return;

    const labels = [...optionsContainer.querySelectorAll(".option-label")].map(el => el.value.trim());
    const freqs  = [...optionsContainer.querySelectorAll(".option-freq")].map(el => parseFloat(el.value));

    currentConfig = {
      question: questionInput.value.trim(),
      options: labels.map((label, i) => ({ label, freq: freqs[i] })),
      syncSquare: syncToggle.checked,
      refreshRate: detectedRefreshRate,
    };

    logEvent("config_set", { config: currentConfig });

    buildStimulusView(currentConfig);
    setupView.classList.add("hidden");
    patientView.classList.remove("hidden");
    document.body.classList.add("patient-view");
  }

  function showSetupView() {
    stopFlicker();
    patientView.classList.add("hidden");
    setupView.classList.remove("hidden");
    document.body.classList.remove("patient-view");
    logEvent("returned_to_setup");
  }

  // ── Init ───────────────────────────────────────────────────
  async function init() {
    detectedRefreshRate = await detectRefreshRate();
    detectedHzEl.textContent = `${detectedRefreshRate} Hz`;
    validFrequencies = computeValidFrequencies(detectedRefreshRate);
    validFreqsEl.textContent = validFrequencies.join(", ") + " Hz";

    buildOptionRows();

    // Event listeners
    numOptionsSelect.addEventListener("change", buildOptionRows);
    questionInput.addEventListener("input", validate);
    optionsContainer.addEventListener("input", validate);
    optionsContainer.addEventListener("change", validate);
    startBtn.addEventListener("click", showPatientView);
    backBtn.addEventListener("click", showSetupView);
    downloadLogBtn.addEventListener("click", downloadLog);
    playPauseBtn.addEventListener("click", () => {
      isRunning ? stopFlicker() : startFlicker();
    });
  }

  init();
})();
