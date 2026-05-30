/**
 * Shadow AI - DOMContentLoaded setup and primary UI event binding.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

function cancelBootResponseBody(response) {
  try {
    if (response && response.body && typeof response.body.cancel === 'function') {
      response.body.cancel().catch(() => {});
    }
  } catch {}
}

async function readBootResponseTextWithTimeout(response, timeoutMs = LOCAL_API_TIMEOUT_MS) {
  let timeoutId = null;
  const bodyPromise = response.text();
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      cancelBootResponseBody(response);
      reject(new Error(`Response body timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([bodyPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function readBootResponseJsonWithTimeout(response, timeoutMs = LOCAL_API_TIMEOUT_MS) {
  const text = await readBootResponseTextWithTimeout(response, timeoutMs);
  if (!String(text || '').trim()) return {};
  return JSON.parse(text);
}

// --- Missing-credential popup ---
let lastCredentialPromptAt = 0;
let lastCredentialPromptKey = '';

// Open Settings (reusing its existing populate handler) and draw the user's eye to the
// exact field they need to fill. For subagent-provider keys, select that provider first
// so its (otherwise hidden) key field becomes visible.
function openSettingsToField(fieldId, subagentProvider = '') {
  if (typeof btnSettings !== 'undefined' && btnSettings) btnSettings.click();
  if (subagentProvider && typeof selectSubagentProvider !== 'undefined' && selectSubagentProvider) {
    selectSubagentProvider.value = subagentProvider;
    selectSubagentProvider.dispatchEvent(new Event('change'));
  }
  if (!fieldId) return;
  const field = document.getElementById(fieldId);
  if (!field) return;
  // Defer so the settings modal has rendered before we scroll/focus inside it.
  setTimeout(() => {
    try {
      field.scrollIntoView({ behavior: 'smooth', block: 'center' });
      field.classList.add('field-attention');
      field.focus({ preventScroll: true });
      setTimeout(() => field.classList.remove('field-attention'), 3800);
    } catch {}
  }, 60);
}

// Show the actionable "add your key" popup for a recognized credential. Debounced so a
// burst of failures (e.g. retries) does not reopen the same prompt repeatedly.
function showCredentialPrompt(credentialKey, reason = '') {
  const config = typeof getCredentialPromptConfig === 'function'
    ? getCredentialPromptConfig(credentialKey)
    : null;
  if (!config || typeof credentialModal === 'undefined' || !credentialModal) return false;

  const now = Date.now();
  if (lastCredentialPromptKey === credentialKey && (now - lastCredentialPromptAt) < 15000) return false;
  lastCredentialPromptAt = now;
  lastCredentialPromptKey = credentialKey;

  if (credentialModalTitle) credentialModalTitle.textContent = config.title;
  if (credentialModalMessage) {
    credentialModalMessage.textContent = config.getKeyUrl
      ? `${config.label} isn't set yet, so that action couldn't run. Get a key from the provider, then open Settings to paste it in.`
      : `${config.label} isn't set yet, so that action couldn't run. Open Settings to add it.`;
  }
  if (typeof btnCredentialGetKey !== 'undefined' && btnCredentialGetKey) {
    if (config.getKeyUrl) {
      btnCredentialGetKey.href = config.getKeyUrl;
      btnCredentialGetKey.textContent = config.getKeyLabel || 'Get your key →';
      btnCredentialGetKey.classList.remove('hidden');
    } else {
      btnCredentialGetKey.classList.add('hidden');
      btnCredentialGetKey.removeAttribute('href');
    }
  }
  credentialModal.dataset.fieldId = config.fieldId || '';
  credentialModal.dataset.subagentProvider = config.subagentProvider || '';
  credentialModal.classList.remove('hidden');
  return true;
}

// --- Initialization & UI Binding ---
window.addEventListener('DOMContentLoaded', async () => {
  // Load settings into inputs
  loadFavoriteVoices();
  populateGeminiVoiceSelect(selectVoice);
  const normalizedVoiceName = normalizeGeminiVoiceName(voiceName);
  if (normalizedVoiceName && normalizedVoiceName !== voiceName) {
    voiceName = normalizedVoiceName;
    localStorage.setItem('shadow_voice', voiceName);
  }
  if (!normalizedVoiceName) {
    voiceName = DEFAULT_GEMINI_VOICE;
    localStorage.setItem('shadow_voice', voiceName);
  }
  inputApiKey.value = apiKey;
  if (inputAssistantName) inputAssistantName.value = getAssistantName();
  if (inputUserName) inputUserName.value = getUserName();
  if (typeof syncMemoryGraphAssistantLabels === 'function') syncMemoryGraphAssistantLabels();
  selectVoice.value = voiceName;
  selectedModel = normalizeLiveModel(selectedModel);
  localStorage.setItem('shadow_model', selectedModel);
  selectModel.value = selectedModel;
  liveThinkingLevel = migrateLiveThinkingDefault(liveThinkingLevel);
  localStorage.setItem('shadow_live_thinking_level', liveThinkingLevel);
  if (selectLiveThinkingLevel) {
    selectLiveThinkingLevel.value = liveThinkingLevel;
  }
  if (selectEchoGate) {
    selectEchoGate.value = echoGateLevel;
  }
  normalizeProactiveProfile();
  syncProactiveControls();

  function loadMemoryBackupSettings() {
    const savedEnabled = localStorage.getItem('shadow_memory_backup_enabled');
    memoryBackupEnabled = savedEnabled === 'true';
    const savedInterval = localStorage.getItem('shadow_memory_backup_interval');
    memoryBackupIntervalMinutes = savedInterval ? parseInt(savedInterval, 10) : 60;
    initMemoryBackupScheduler();
  }

  function getMemoryBackupScheduleKey() {
    const interval = parseInt(memoryBackupIntervalMinutes, 10);
    const active = Boolean(memoryBackupEnabled && interval > 0);
    return `${active ? 'enabled' : 'disabled'}:${active ? interval : 0}`;
  }

  function initMemoryBackupScheduler() {
    if (memoryBackupTimer) {
      clearInterval(memoryBackupTimer);
      memoryBackupTimer = null;
    }
    memoryBackupScheduleKey = getMemoryBackupScheduleKey();
    if (!memoryBackupEnabled || !memoryBackupIntervalMinutes || memoryBackupIntervalMinutes <= 0) {
      return;
    }
    const intervalMs = memoryBackupIntervalMinutes * 60 * 1000;
    memoryBackupTimer = setInterval(async () => {
      try {
        const res = await fetchLocalApiWithTimeout('/api/memories/backup', { method: 'POST' }, MEMORY_BACKUP_TIMEOUT_MS);
        const data = await readBootResponseJsonWithTimeout(res, MEMORY_BACKUP_TIMEOUT_MS);
        if (data.status === 'success') {
          console.log('[Memory Backup] Automated backup created:', data.backupFile);
        } else if (data.status === 'no_memories_file' || data.status === 'no_memories' || data.status === 'empty') {
          console.debug('[Memory Backup] Nothing to back up yet.');
        } else {
          console.warn('[Memory Backup] Backup skipped:', data);
        }
      } catch (e) {
        console.error('[Memory Backup] Backup error:', e);
      }
    }, intervalMs);
    console.log(`[Memory Backup] Scheduler started with interval: ${memoryBackupIntervalMinutes} minutes`);
  }

  function stopMemoryBackupScheduler() {
    if (memoryBackupTimer) {
      clearInterval(memoryBackupTimer);
      memoryBackupTimer = null;
      console.log('[Memory Backup] Scheduler stopped');
    }
  }

  function syncMemoryBackupScheduler() {
    const nextScheduleKey = getMemoryBackupScheduleKey();
    if (nextScheduleKey === memoryBackupScheduleKey) return;
    stopMemoryBackupScheduler();
    initMemoryBackupScheduler();
  }

  function syncMemoryBackupUI() {
    if (inputMemoryBackupEnabled) {
      inputMemoryBackupEnabled.checked = memoryBackupEnabled;
    }
    if (selectMemoryBackupInterval) {
      const intervalStr = String(memoryBackupIntervalMinutes);
      const optionExists = [...selectMemoryBackupInterval.options].some(o => o.value === intervalStr);
      if (optionExists) {
        selectMemoryBackupInterval.value = intervalStr;
        memoryBackupCustomGroup.classList.add('hidden');
      } else {
        selectMemoryBackupInterval.value = 'custom';
        memoryBackupCustomGroup.classList.remove('hidden');
        if (inputMemoryBackupCustomMinutes) {
          inputMemoryBackupCustomMinutes.value = memoryBackupIntervalMinutes;
        }
      }
    }
  }

  function updateMemoryBackupCustomVisibility() {
    if (selectMemoryBackupInterval && memoryBackupCustomGroup) {
      if (selectMemoryBackupInterval.value === 'custom') {
        memoryBackupCustomGroup.classList.remove('hidden');
      } else {
        memoryBackupCustomGroup.classList.add('hidden');
      }
    }
  }

  selectSubagentProvider.value = subagentProvider;
  if (subagentProvider === 'gemini') selectSubagentModelGemini.value = subagentModel || 'models/gemini-3.1-flash-lite';
  if (subagentProvider === OPENAI_CODEX_PROVIDER) selectSubagentModelOpenaiCodex.value = subagentModel || 'gpt-5.5';
  if (subagentProvider === 'minimax') selectSubagentModelMinimax.value = subagentModel || 'minimax-m2.7';
  if (subagentProvider === 'moonshot') selectSubagentModelMoonshot.value = subagentModel || 'moonshotai/kimi-k2.6';
  if (subagentProvider === 'ollama') selectSubagentModelOllama.value = subagentModel || 'deepseek-v3.1:671b-cloud';
  if (selectSubagentReasoningMode) {
    selectSubagentReasoningMode.value = OPENAI_CODEX_REASONING_MODES.has(subagentReasoningMode) ? subagentReasoningMode : 'medium';
  }
  if (inputSmartMainRoutingEnabled) inputSmartMainRoutingEnabled.checked = smartMainRoutingEnabled;
  inputMinimaxKey.value = minimaxApiKey;
  inputMoonshotKey.value = moonshotApiKey;
  inputOllamaKey.value = ollamaApiKey;
  if (inputSearxngSearchUrl) inputSearxngSearchUrl.value = searxngSearchUrl;
  if (inputSearxngSearchPort) inputSearxngSearchPort.value = searxngSearchPort;

  function isCodexReasoningVisible() {
    return selectSubagentProvider.value === OPENAI_CODEX_PROVIDER &&
      OPENAI_CODEX_REASONING_MODELS.has(selectSubagentModelOpenaiCodex.value);
  }

  function updateCodexReasoningUI() {
    if (!groupSubagentReasoningMode) return;
    groupSubagentReasoningMode.style.display = isCodexReasoningVisible() ? 'flex' : 'none';
  }

  function updateCodexAuthUI(status = {}) {
    const connected = Boolean(status.connected);
    if (openaiCodexStatusBadge) {
      openaiCodexStatusBadge.classList.toggle('integration-connected', connected);
      openaiCodexStatusBadge.classList.toggle('integration-disconnected', !connected);
    }
    if (openaiCodexStatusText) {
      openaiCodexStatusText.textContent = connected ? 'Logged in' : 'Logged out';
    }
    if (openaiCodexStatusDetails) {
      openaiCodexStatusDetails.textContent = status.detail || (connected
        ? 'Codex OAuth credentials are available for GPT subagents.'
        : 'Login with Codex to use GPT-5.5 or GPT-5.4 subagents.');
    }
    if (btnOpenaiCodexLogin) btnOpenaiCodexLogin.classList.toggle('hidden', connected);
    if (btnOpenaiCodexLogout) btnOpenaiCodexLogout.classList.toggle('hidden', !connected);
  }

  async function checkOpenaiCodexStatus() {
    try {
      const res = await fetchLocalApiWithTimeout('/api/codex/status', {}, LOCAL_API_TIMEOUT_MS);
      const data = res.ok ? await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS) : { connected: false, detail: `Status check failed: HTTP ${res.status}` };
      updateCodexAuthUI(data);
      return data;
    } catch (err) {
      updateCodexAuthUI({ connected: false, detail: `Status check failed: ${err.message}` });
      return { connected: false, error: err.message };
    }
  }

  function setOllamaLocalStatus(msg, isError) {
    if (!ollamaLocalStatus) return;
    ollamaLocalStatus.textContent = msg;
    ollamaLocalStatus.style.color = isError ? '#ff6b6b' : 'rgba(255,255,255,0.6)';
  }

  // Auto-detect models installed in the user's local Ollama and fill the picker.
  async function refreshOllamaLocalModels(preferredModel) {
    if (!selectSubagentModelOllamaLocal) return;
    const endpoint = (inputOllamaLocalEndpoint && inputOllamaLocalEndpoint.value.trim()) || ollamaLocalEndpoint || 'http://localhost:11434';
    const want = preferredModel || (subagentProvider === 'ollama_local' ? subagentModel : '') || selectSubagentModelOllamaLocal.value;
    setOllamaLocalStatus('Detecting installed models…', false);
    try {
      const res = await fetchLocalApiWithTimeout(`/api/ollama/local/models?endpoint=${encodeURIComponent(endpoint)}`, {}, LOCAL_API_TIMEOUT_MS);
      const data = await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS);
      const models = (data && Array.isArray(data.models)) ? data.models : [];
      selectSubagentModelOllamaLocal.innerHTML = '';
      if (!models.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No local models found';
        selectSubagentModelOllamaLocal.appendChild(opt);
        setOllamaLocalStatus((data && (data.error || data.hint)) ? (data.error || data.hint) : 'No models found. Run "ollama pull <model>" then Refresh.', true);
        return;
      }
      for (const name of models) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        selectSubagentModelOllamaLocal.appendChild(opt);
      }
      if (want && models.includes(want)) selectSubagentModelOllamaLocal.value = want;
      setOllamaLocalStatus(`Found ${models.length} model${models.length === 1 ? '' : 's'}. Pick one and Save.`, false);
    } catch (err) {
      selectSubagentModelOllamaLocal.innerHTML = '<option value="">No local models found</option>';
      setOllamaLocalStatus('Could not reach Ollama. Make sure it is installed and running, then Refresh.', true);
    }
  }

  function updateProviderUI() {
    groupMinimaxKey.style.display = 'none';
    groupMoonshotKey.style.display = 'none';
    groupOllamaSettings.style.display = 'none';
    if (groupOllamaLocalSettings) groupOllamaLocalSettings.style.display = 'none';
    groupOpenaiCodexAuth.style.display = 'none';
    selectSubagentModelGemini.style.display = 'none';
    selectSubagentModelOpenaiCodex.style.display = 'none';
    selectSubagentModelMinimax.style.display = 'none';
    selectSubagentModelMoonshot.style.display = 'none';
    selectSubagentModelOllama.style.display = 'none';
    if (selectSubagentModelOllamaLocal) selectSubagentModelOllamaLocal.style.display = 'none';

    const prov = selectSubagentProvider.value;
    if (prov === 'gemini') selectSubagentModelGemini.style.display = 'block';
    if (prov === OPENAI_CODEX_PROVIDER) {
      groupOpenaiCodexAuth.style.display = 'flex';
      selectSubagentModelOpenaiCodex.style.display = 'block';
      checkOpenaiCodexStatus();
    }
    if (prov === 'minimax') { groupMinimaxKey.style.display = 'block'; selectSubagentModelMinimax.style.display = 'block'; }
    if (prov === 'moonshot') { groupMoonshotKey.style.display = 'block'; selectSubagentModelMoonshot.style.display = 'block'; }
    if (prov === 'ollama') { groupOllamaSettings.style.display = 'block'; selectSubagentModelOllama.style.display = 'block'; }
    if (prov === 'ollama_local') {
      if (groupOllamaLocalSettings) groupOllamaLocalSettings.style.display = 'block';
      if (selectSubagentModelOllamaLocal) selectSubagentModelOllamaLocal.style.display = 'block';
      if (inputOllamaLocalEndpoint) inputOllamaLocalEndpoint.value = ollamaLocalEndpoint;
      refreshOllamaLocalModels();
    }
    updateCodexReasoningUI();
  }
  updateProviderUI();
  selectSubagentProvider.addEventListener('change', updateProviderUI);
  if (btnRefreshOllamaLocalModels) {
    btnRefreshOllamaLocalModels.addEventListener('click', () => {
      if (inputOllamaLocalEndpoint) ollamaLocalEndpoint = inputOllamaLocalEndpoint.value.trim() || 'http://localhost:11434';
      refreshOllamaLocalModels();
    });
  }
  if (selectSubagentModelOpenaiCodex) {
    selectSubagentModelOpenaiCodex.addEventListener('change', updateCodexReasoningUI);
  }

  if (selectMemoryBackupInterval) {
    selectMemoryBackupInterval.addEventListener('change', updateMemoryBackupCustomVisibility);
  }

  // Initialize Canvas dimensions
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Load from backend config if exists
  await loadConfigFromServer();
  if (typeof recoverOrphanedActiveSubagentSnapshots === 'function') {
    recoverOrphanedActiveSubagentSnapshots();
  }
  loadMemoryBackupSettings();
  startBackendHealthMonitor();
  checkGoogleStatus();

  // Show onboarding if no key is saved
  if (!apiKey) {
    onboardingModal.classList.remove('hidden');
  }

  // Setup Event Listeners
  btnSettings.addEventListener('click', () => {
    inputApiKey.value = apiKey;
    if (inputUserName) inputUserName.value = getUserName();
    selectVoice.value = voiceName;
    selectAccent.value = accent;
    selectModel.value = selectedModel;
    if (selectLiveThinkingLevel) selectLiveThinkingLevel.value = liveThinkingLevel;
    if (inputSmartMainRoutingEnabled) inputSmartMainRoutingEnabled.checked = smartMainRoutingEnabled;
    if (selectEchoGate) {
      selectEchoGate.value = echoGateLevel;
    }
    selectSubagentProvider.value = subagentProvider;
    if (subagentProvider === 'gemini') selectSubagentModelGemini.value = subagentModel || 'models/gemini-3.1-flash-lite';
    if (subagentProvider === OPENAI_CODEX_PROVIDER) selectSubagentModelOpenaiCodex.value = subagentModel || 'gpt-5.5';
    if (subagentProvider === 'minimax') selectSubagentModelMinimax.value = subagentModel || 'minimax-m2.7';
    if (subagentProvider === 'moonshot') selectSubagentModelMoonshot.value = subagentModel || 'moonshotai/kimi-k2.6';
    if (subagentProvider === 'ollama') selectSubagentModelOllama.value = subagentModel || 'deepseek-v3.1:671b-cloud';
    if (selectSubagentReasoningMode) selectSubagentReasoningMode.value = subagentReasoningMode;
    if (inputSearxngSearchUrl) inputSearxngSearchUrl.value = searxngSearchUrl;
    if (inputSearxngSearchPort) inputSearxngSearchPort.value = searxngSearchPort;
    updateProviderUI();
    syncProactiveControls();
    syncMemoryBackupUI();
    settingsModal.classList.remove('hidden');
  });

  if (btnDiagnostics && diagnosticsPanel) {
    btnDiagnostics.addEventListener('click', () => {
      diagnosticsPanel.classList.toggle('hidden');
      updateDiagnosticsPanel();
    });
  }

  btnCloseSettings.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  // Missing-credential popup wiring
  if (btnCloseCredential && credentialModal) {
    btnCloseCredential.addEventListener('click', () => credentialModal.classList.add('hidden'));
  }
  if (btnCredentialOpenSettings) {
    btnCredentialOpenSettings.addEventListener('click', () => {
      const fieldId = credentialModal ? (credentialModal.dataset.fieldId || '') : '';
      const provider = credentialModal ? (credentialModal.dataset.subagentProvider || '') : '';
      if (credentialModal) credentialModal.classList.add('hidden');
      openSettingsToField(fieldId, provider);
    });
  }

  if (selectVoice) {
    selectVoice.addEventListener('change', syncFavoriteVoiceButton);
  }

  if (btnFavoriteVoice) {
    btnFavoriteVoice.addEventListener('click', () => {
      toggleCurrentVoiceFavorite();
      saveConfigToServer().then(saved => {
        if (!saved) addSystemMessage('Favorite voices saved locally. Server config sync is queued and will retry automatically.');
      });
    });
  }

  btnSaveSettings.addEventListener('click', async () => {
    const oldApiKey = apiKey;
    const oldAssistantName = getAssistantName();
    const oldVoice = voiceName;
    const oldModel = selectedModel;
    const oldLiveThinkingLevel = liveThinkingLevel;
    const oldSmartMainRoutingEnabled = smartMainRoutingEnabled;
    btnSaveSettings.disabled = true;
    btnSaveSettings.textContent = 'Saving...';

    try {
      apiKey = inputApiKey.value.trim();
      if (inputAssistantName) assistantName = normalizeAssistantName(inputAssistantName.value);
      if (inputUserName) userName = normalizeUserName(inputUserName.value);
      voiceName = selectVoice.value;
      selectedModel = selectModel.value;
      if (selectLiveThinkingLevel) {
        liveThinkingLevel = normalizeLiveThinkingLevel(selectLiveThinkingLevel.value);
      }
      if (inputSmartMainRoutingEnabled) {
        smartMainRoutingEnabled = inputSmartMainRoutingEnabled.checked;
      }
      if (selectEchoGate) {
        echoGateLevel = selectEchoGate.value;
      }
      const oldProactiveEnabled = proactiveEnabled;
      if (inputProactiveEnabled) {
        proactiveEnabled = inputProactiveEnabled.checked;
      }
      const oldProactiveProfile = proactiveProfile;
      if (selectProactiveProfile) {
        proactiveProfile = normalizeProactiveProfile(selectProactiveProfile.value);
      } else {
        normalizeProactiveProfile();
      }
      const oldAccent = accent;
      accent = selectAccent.value;

      localStorage.setItem('shadow_api_key', apiKey);
      localStorage.setItem('shadow_assistant_name', assistantName);
      if (inputAssistantName) inputAssistantName.value = assistantName;
      localStorage.setItem('shadow_user_name', userName);
      if (inputUserName) inputUserName.value = userName;
      if (typeof syncMemoryGraphAssistantLabels === 'function') syncMemoryGraphAssistantLabels();
      // Rewrite the actual 'user'/'shadow' graph nodes so a rename shows up in memories.
      if (typeof apiSyncIdentityNodes === 'function') apiSyncIdentityNodes();
      localStorage.setItem('shadow_voice', voiceName);
      localStorage.setItem('shadow_model', selectedModel);
      localStorage.setItem('shadow_live_thinking_level', liveThinkingLevel);
      localStorage.setItem('shadow_smart_main_routing_enabled', smartMainRoutingEnabled ? 'true' : 'false');
      localStorage.setItem('shadow_accent', accent);
      localStorage.setItem('shadow_echo_gate', echoGateLevel);
      localStorage.setItem('shadow_proactive_enabled', proactiveEnabled ? 'true' : 'false');
      localStorage.setItem('shadow_proactive_profile', proactiveProfile);
      syncProactiveControls();
      if (!proactiveEnabled && oldProactiveEnabled) {
        stopProactiveAttention();
      }
      if (proactiveEnabled && (!oldProactiveEnabled || oldProactiveProfile !== proactiveProfile)) {
        signalProactiveAttention('settings_changed');
      }

      subagentProvider = selectSubagentProvider.value;
      if (subagentProvider === 'gemini') subagentModel = selectSubagentModelGemini.value;
      else if (subagentProvider === OPENAI_CODEX_PROVIDER) subagentModel = selectSubagentModelOpenaiCodex.value;
      else if (subagentProvider === 'minimax') subagentModel = selectSubagentModelMinimax.value;
      else if (subagentProvider === 'moonshot') subagentModel = selectSubagentModelMoonshot.value;
      else if (subagentProvider === 'ollama') subagentModel = selectSubagentModelOllama.value;
      else if (subagentProvider === 'ollama_local') subagentModel = selectSubagentModelOllamaLocal ? selectSubagentModelOllamaLocal.value : '';
      else subagentModel = '';
      if (inputOllamaLocalEndpoint) {
        ollamaLocalEndpoint = inputOllamaLocalEndpoint.value.trim() || 'http://localhost:11434';
      }
      if (selectSubagentReasoningMode) {
        const requestedReasoningMode = selectSubagentReasoningMode.value;
        subagentReasoningMode = OPENAI_CODEX_REASONING_MODES.has(requestedReasoningMode) ? requestedReasoningMode : 'medium';
      }

      minimaxApiKey = inputMinimaxKey.value.trim();
      moonshotApiKey = inputMoonshotKey.value.trim();
      ollamaApiKey = inputOllamaKey.value.trim();
      searxngSearchUrl = inputSearxngSearchUrl ? inputSearxngSearchUrl.value.trim() : searxngSearchUrl;
      searxngSearchPort = inputSearxngSearchPort ? inputSearxngSearchPort.value.trim() : searxngSearchPort;
      if (!searxngSearchUrl) searxngSearchUrl = 'http://127.0.0.1/search';
      if (!searxngSearchPort) searxngSearchPort = '8888';

      localStorage.setItem('shadow_subagent_provider', subagentProvider);
      localStorage.setItem('shadow_subagent_model', subagentModel);
      localStorage.setItem('shadow_subagent_reasoning_mode', subagentReasoningMode);
      localStorage.setItem('shadow_minimax_key', minimaxApiKey);
      localStorage.setItem('shadow_moonshot_key', moonshotApiKey);

      localStorage.setItem('shadow_ollama_key', ollamaApiKey);
      localStorage.setItem('shadow_ollama_local_endpoint', ollamaLocalEndpoint);
      localStorage.setItem('shadow_searxng_url', searxngSearchUrl);
      localStorage.setItem('shadow_searxng_port', searxngSearchPort);

      if (inputMemoryBackupEnabled) {
        memoryBackupEnabled = inputMemoryBackupEnabled.checked;
        localStorage.setItem('shadow_memory_backup_enabled', memoryBackupEnabled ? 'true' : 'false');
      }
      if (selectMemoryBackupInterval) {
        let intervalVal = selectMemoryBackupInterval.value;
        if (intervalVal === 'custom') {
          intervalVal = parseInt(inputMemoryBackupCustomMinutes?.value || '60', 10);
          if (isNaN(intervalVal) || intervalVal <= 0) intervalVal = 60;
        }
        memoryBackupIntervalMinutes = parseInt(intervalVal, 10);
        localStorage.setItem('shadow_memory_backup_interval', String(memoryBackupIntervalMinutes));
      }
      syncMemoryBackupScheduler();

      settingsModal.classList.add('hidden');
      addSystemMessage(`Settings saved locally. Subagents will use ${subagentProvider}${subagentModel ? ` / ${subagentModel}` : ''} for newly spawned agents.`);

      const voiceChanged = oldVoice !== voiceName;
      const assistantNameChanged = oldAssistantName !== getAssistantName();
      const liveThinkingChanged = oldLiveThinkingLevel !== liveThinkingLevel;
      const smartMainRoutingChanged = oldSmartMainRoutingEnabled !== smartMainRoutingEnabled;
      const accentChanged = oldAccent !== accent;
      if (shouldStartFreshVoiceSession(oldVoice, voiceName)) {
        clearLiveSessionResumptionToken();
      }
      if (liveThinkingChanged) {
        clearLiveSessionResumptionToken();
      }
      if (smartMainRoutingChanged) {
        clearLiveSessionResumptionToken();
      }
      if (assistantNameChanged) {
        clearLiveSessionResumptionToken();
        if (isGraphOpen && updateGraphVisualization) updateGraphVisualization();
      }

      saveConfigToServer().then(saved => {
        if (!saved) addSystemMessage('Settings saved locally. Server config sync is queued and will retry automatically.');
      });

      // If currently connected and important voice-call settings changed, perform a clean reconnect.
      // Subagent provider/model changes are intentionally applied without reconnecting.
      if (isConnected && (oldApiKey !== apiKey || assistantNameChanged || voiceChanged || oldModel !== selectedModel || liveThinkingChanged || smartMainRoutingChanged || accentChanged)) {
        const changedWhat = [];
        if (oldApiKey !== apiKey) changedWhat.push('API key');
        if (assistantNameChanged) changedWhat.push('assistant name');
        if (voiceChanged) changedWhat.push('voice');
        if (oldModel !== selectedModel) changedWhat.push('voice model');
        if (liveThinkingChanged) changedWhat.push('voice reasoning');
        if (smartMainRoutingChanged) changedWhat.push('subagent prompt brain');
        if (accentChanged) changedWhat.push('accent');
        addSystemMessage(`${changedWhat.join(' / ')} changed. Reconnecting to apply new voice configuration...`);

        disconnect();
        setTimeout(() => {
          connect();
        }, 1000);
      }
    } catch (err) {
      console.error('Failed to save settings:', err);
      addSystemMessage(`Settings save failed: ${err.message}`);
    } finally {
      btnSaveSettings.disabled = false;
      btnSaveSettings.textContent = 'Save Changes';
    }
  });

  btnGetStarted.addEventListener('click', async () => {
    const key = onboardingApiKey.value.trim();
    if (!key) {
      alert('Please enter a valid Gemini API Key to proceed.');
      return;
    }
    apiKey = key;
    localStorage.setItem('shadow_api_key', apiKey);

    await saveConfigToServer();

    onboardingModal.classList.add('hidden');
    addSystemMessage('Welcome initialized. Settings saved.');
  });

  btnToggleKeyVisibility.addEventListener('click', () => {
    if (inputApiKey.type === 'password') {
      inputApiKey.type = 'text';
      btnToggleKeyVisibility.textContent = 'Hide';
    } else {
      inputApiKey.type = 'password';
      btnToggleKeyVisibility.textContent = 'Show';
    }
  });

  if (btnOpenaiCodexLogin) {
    btnOpenaiCodexLogin.addEventListener('click', async () => {
      btnOpenaiCodexLogin.disabled = true;
      btnOpenaiCodexLogin.textContent = 'Opening...';
      try {
        const res = await fetchLocalApiWithTimeout('/api/codex/login', { method: 'POST' }, CODEX_AUTH_API_TIMEOUT_MS);
        const data = await readBootResponseJsonWithTimeout(res, CODEX_AUTH_API_TIMEOUT_MS).catch(() => ({}));
        if (!res.ok || data.status === 'error') {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        updateCodexAuthUI({ connected: false, detail: data.message || 'Complete the Codex login in your browser, then status will update automatically.' });
        addSystemMessage('Codex login opened. Complete the browser login flow, then return to Shadow.');

        let pollCount = 0;
        const pollTimer = setInterval(async () => {
          pollCount++;
          const status = await checkOpenaiCodexStatus();
          if (status.connected || pollCount > 150) {
            clearInterval(pollTimer);
            if (status.connected) addSystemMessage('OpenAI Codex login is connected.');
          }
        }, 2000);
      } catch (err) {
        console.error('Codex login failed:', err);
        alert(`Could not start Codex login: ${err.message}`);
      } finally {
        btnOpenaiCodexLogin.disabled = false;
        btnOpenaiCodexLogin.textContent = 'Login with Codex';
      }
    });
  }

  if (btnOpenaiCodexLogout) {
    btnOpenaiCodexLogout.addEventListener('click', async () => {
      btnOpenaiCodexLogout.disabled = true;
      btnOpenaiCodexLogout.textContent = 'Logging out...';
      try {
        const res = await fetchLocalApiWithTimeout('/api/codex/logout', { method: 'POST' }, CODEX_AUTH_API_TIMEOUT_MS);
        const data = await readBootResponseJsonWithTimeout(res, CODEX_AUTH_API_TIMEOUT_MS).catch(() => ({}));
        if (!res.ok || data.status === 'error') {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        await checkOpenaiCodexStatus();
        addSystemMessage('OpenAI Codex login disconnected.');
      } catch (err) {
        console.error('Codex logout failed:', err);
        alert(`Could not log out of Codex: ${err.message}`);
      } finally {
        btnOpenaiCodexLogout.disabled = false;
        btnOpenaiCodexLogout.textContent = 'Logout';
      }
    });
  }

  btnConnect.addEventListener('click', toggleConnection);
  btnToggleMic.addEventListener('click', toggleMute);
  let interruptPointerHandled = false;
  btnInterrupt.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    interruptPointerHandled = true;
    event.preventDefault();
    manualInterrupt({ sendToServer: true });
  });
  btnInterrupt.addEventListener('click', (event) => {
    event.preventDefault();
    if (interruptPointerHandled) {
      interruptPointerHandled = false;
      return;
    }
    manualInterrupt({ sendToServer: true });
  });

  if (btnNewSession) {
    btnNewSession.addEventListener('click', () => {
      showCustomConfirm(
        'Confirm New Session',
        'Are you sure you want to clear session history and start a fresh conversation?',
        async () => {
          clearLiveSessionResumptionToken();
          localStorage.setItem('shadow_is_whispering', 'false');
          await saveConfigToServer();

          // Clear the UI and all tracking variables
          if (transcriptFeed) transcriptFeed.innerHTML = '';
          currentAITranscript = '';
          currentUserTranscript = '';
          recentAIOutputForEcho = '';
          lastOutputTranscriptionText = '';
          currentAITranscriptHasModelText = false;
          aiSpeechStartTime = 0;
          clearRecentDialogueTurns();

          addSystemMessage('Clearing session history and starting a fresh conversation...');
          updateSessionButtonVisibility();
          if (isConnected) {
            disconnect();
            setTimeout(async () => {
              await connect();
            }, 500);
          } else {
            await connect();
          }
        }
      );
    });
  }

  // Memory Graph DOM bindings and initialization
  const btnMemory = document.getElementById('btn-memory');
  const memoryModal = document.getElementById('memory-modal');
  const btnCloseMemory = document.getElementById('btn-close-memory');
  const btnResetMemories = document.getElementById('btn-reset-memories');
  const btnFactoryReset = document.getElementById('btn-factory-reset');
  const memoryCanvas = document.getElementById('memory-graph-canvas');
  const graphTooltip = document.getElementById('graph-tooltip');

  let sim = null;
  if (memoryCanvas && graphTooltip) {
    sim = new MemoryGraphSimulation(memoryCanvas, graphTooltip);
    updateGraphVisualization = () => {
      if (sim) sim.loadGraph();
    };
  }

  if (btnMemory && memoryModal) {
    btnMemory.addEventListener('click', async () => {
      isGraphOpen = true;
      if (typeof syncMemoryGraphAssistantLabels === 'function') syncMemoryGraphAssistantLabels();
      // Heal stale identity-node labels (e.g. an old "You") before rendering.
      if (typeof apiSyncIdentityNodes === 'function') { try { await apiSyncIdentityNodes(); } catch (e) {} }
      memoryModal.classList.remove('hidden');
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (sim) sim.start();
        }, 100);
      });
    });
  }

  // Skills manager (list / view / delete self-learned skills)
  const btnSkills = document.getElementById('btn-skills');
  const skillsModal = document.getElementById('skills-modal');
  const btnCloseSkills = document.getElementById('btn-close-skills');
  const skillsListEl = document.getElementById('skills-list');
  const btnWipeSkills = document.getElementById('btn-wipe-skills');

  async function renderSkillsList() {
    if (!skillsListEl) return;
    skillsListEl.innerHTML = '';
    let skills = [];
    try {
      const res = await fetchLocalApiWithTimeout('/api/skills/all', {}, LOCAL_API_TIMEOUT_MS);
      const data = await readBootResponseJsonWithTimeout(res, LOCAL_API_TIMEOUT_MS);
      skills = Array.isArray(data.skills) ? data.skills : (data.skills ? [data.skills] : []);
    } catch (err) {
      const e = document.createElement('div');
      e.className = 'skills-empty';
      e.textContent = 'Could not load skills: ' + (err && err.message ? err.message : 'unknown error');
      skillsListEl.appendChild(e);
      return;
    }
    if (!skills.length) {
      const e = document.createElement('div');
      e.className = 'skills-empty';
      e.textContent = 'No self-learned skills yet. Shadow saves reusable workflows here as it learns them.';
      skillsListEl.appendChild(e);
      return;
    }
    for (const skill of skills) {
      const name = String(skill.name || '');
      const details = document.createElement('details');
      details.className = 'skill-item';
      const summary = document.createElement('summary');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'skill-name';
      nameSpan.textContent = name;
      const delBtn = document.createElement('button');
      delBtn.className = 'danger-button skill-delete';
      delBtn.type = 'button';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!confirm(`Delete the skill "${name}"? This cannot be undone.`)) return;
        try {
          await fetchLocalApiWithTimeout('/api/skills/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skill_name: name })
          }, LOCAL_API_TIMEOUT_MS);
        } catch (err) {
          alert('Failed to delete skill: ' + (err && err.message ? err.message : 'unknown error'));
          return;
        }
        renderSkillsList();
      });
      summary.appendChild(nameSpan);
      summary.appendChild(delBtn);
      details.appendChild(summary);
      const instr = document.createElement('div');
      instr.className = 'skill-instructions';
      instr.textContent = String(skill.instructions || '(no instructions saved)');
      details.appendChild(instr);
      skillsListEl.appendChild(details);
    }
  }

  if (btnSkills && skillsModal) {
    btnSkills.addEventListener('click', () => {
      skillsModal.classList.remove('hidden');
      renderSkillsList();
    });
  }
  if (btnCloseSkills && skillsModal) {
    btnCloseSkills.addEventListener('click', () => skillsModal.classList.add('hidden'));
  }
  if (btnWipeSkills) {
    btnWipeSkills.addEventListener('click', async () => {
      if (!confirm('Delete ALL self-learned skills? This cannot be undone.')) return;
      try {
        await fetchLocalApiWithTimeout('/api/skills/all', { method: 'DELETE' }, LOCAL_API_TIMEOUT_MS);
      } catch (err) {
        alert('Failed to wipe skills: ' + (err && err.message ? err.message : 'unknown error'));
        return;
      }
      renderSkillsList();
    });
  }

  if (btnCloseMemory && memoryModal) {
    btnCloseMemory.addEventListener('click', () => {
      isGraphOpen = false;
      memoryModal.classList.add('hidden');
      if (sim) sim.stop();
    });
  }

  if (btnResetMemories) {
    btnResetMemories.addEventListener('click', () => {
      showCustomConfirm(
        'Confirm Memory Wipe',
        "Are you absolutely sure you want to wipe Shadow's entire long-term memory? This cannot be undone! (An automatic backup of your current memories will be made.)",
        async () => {
          // Perform automatic backup before wiping
          try {
            const backupRes = await fetchLocalApiWithTimeout('/api/memories/backup', { method: 'POST' }, MEMORY_BACKUP_TIMEOUT_MS);
            const backupData = await readBootResponseJsonWithTimeout(backupRes, MEMORY_BACKUP_TIMEOUT_MS);
            if (backupData.status === 'success') {
              console.log('Automated memories backup created successfully:', backupData.backupFile);
            }
          } catch (e) {
            console.error('Failed to create memories backup:', e);
          }

          const defaultJson = {
            nodes: [
              { id: "user", label: getUserName() || 'You', type: "person", description: getUserName() ? `The user, ${getUserName()} (you)` : 'The user (you)' },
              { id: "shadow", label: getAssistantName(), type: "ai", description: `${getAssistantName()}, your AI companion` }
            ],
            links: [
              { source: "shadow", target: "user", type: "COMPANION_OF" }
            ]
          };
          await fetchLocalApiWithTimeout('/api/memories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(defaultJson)
          }, LOCAL_API_TIMEOUT_MS);
          addSystemMessage("Long-term memories wiped. Backup saved to server.");
          if (sim) sim.loadGraph();
        }
      );
    });
  }

  if (btnFactoryReset) {
    btnFactoryReset.addEventListener('click', () => {
      showCustomConfirm(
        'Factory Reset Ã¢â‚¬â€ Delete EVERYTHING',
        "This will permanently delete ALL memories and skills, returning Shadow AI to a clean slate. This CANNOT be undone! Are you absolutely sure?",
        async () => {
          // A true factory reset: wipe EVERYTHING the app persists — memories, skills,
          // the server config (Gemini + provider API keys and all saved settings), the
          // Google connection (tokens), and all local client state (name, voice, accent,
          // preferences, resumption tokens, favorites). Each step is independent so one
          // failure does not abort the rest; then reload into a genuine first-run state.
          const problems = [];

          try {
            const defaultMemories = {
              nodes: [
                { id: "user", label: getUserName() || 'You', type: "person", description: getUserName() ? `The user, ${getUserName()} (you)` : 'The user (you)' },
                { id: "shadow", label: getAssistantName(), type: "ai", description: `${getAssistantName()}, your AI companion` }
              ],
              links: [
                { source: "shadow", target: "user", type: "COMPANION_OF" }
              ]
            };
            await fetchLocalApiWithTimeout('/api/memories', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(defaultMemories)
            }, LOCAL_API_TIMEOUT_MS);
          } catch (e) { problems.push('memories'); }

          try {
            const skillsReset = await fetchLocalApiWithTimeout('/api/skills/all', { method: 'DELETE' }, SKILLS_RESET_TIMEOUT_MS);
            const skillsResetJson = await readBootResponseJsonWithTimeout(skillsReset, SKILLS_RESET_TIMEOUT_MS).catch(() => ({}));
            if (!skillsReset.ok || skillsResetJson.status !== 'success') problems.push('skills');
          } catch (e) { problems.push('skills'); }

          // Server config: clears the saved Gemini/provider API keys and every saved setting.
          try {
            await fetchLocalApiWithTimeout('/api/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}'
            }, LOCAL_API_TIMEOUT_MS);
          } catch (e) { problems.push('config'); }

          // Google connection: deletes stored OAuth tokens (no-op if not connected).
          try {
            await fetchLocalApiWithTimeout('/api/google/disconnect', { method: 'POST' }, GOOGLE_AUTH_API_TIMEOUT_MS);
          } catch (e) { /* not connected; ignore */ }

          // OpenAI Codex: log out so the OAuth session is cleared too (no-op if not logged in).
          try {
            await fetchLocalApiWithTimeout('/api/codex/logout', { method: 'POST' }, CODEX_AUTH_API_TIMEOUT_MS);
          } catch (e) { /* not logged in; ignore */ }

          // All local client state in one shot (covers every shadow_* key + favorites + tokens).
          try { localStorage.clear(); } catch (e) {}

          addSystemMessage(problems.length
            ? ('Factory reset finished, but these could not be cleared: ' + problems.join(', ') + '. Reloading into a clean slate...')
            : 'Factory reset complete — memories, skills, keys, settings, and Google connection wiped. Reloading into a clean slate...');
          setTimeout(() => { try { location.reload(); } catch (e) {} }, 1400);
        }
      );
    });
  }

  // Integrations Event Listeners
  if (btnIntegrations && integrationsModal) {
    btnIntegrations.addEventListener('click', () => {
      checkGoogleStatus();
      integrationsModal.classList.remove('hidden');
    });
  }

  if (btnCloseIntegrations && integrationsModal) {
    btnCloseIntegrations.addEventListener('click', () => {
      integrationsModal.classList.add('hidden');
    });
  }

  if (btnConnectGoogle) {
    btnConnectGoogle.addEventListener('click', async () => {
      try {
        const statusRes = await fetchLocalApiWithTimeout('/api/google/status', {}, GOOGLE_AUTH_API_TIMEOUT_MS);
        const statusData = statusRes.ok ? await readBootResponseJsonWithTimeout(statusRes, GOOGLE_AUTH_API_TIMEOUT_MS).catch(() => ({})) : {};
        if (statusData && statusData.credentialsConfigured === false) {
          const redirect = statusData.redirectUri ? `\n\nRedirect URL: ${statusData.redirectUri}` : '';
          throw new Error(`${statusData.credentialsError || 'Google OAuth credentials are missing.'}${redirect}`);
        }

        const res = await fetchLocalApiWithTimeout('/api/google/auth-url', {}, GOOGLE_AUTH_API_TIMEOUT_MS);
        if (!res.ok) {
          const errData = await readBootResponseJsonWithTimeout(res, GOOGLE_AUTH_API_TIMEOUT_MS).catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        const data = await readBootResponseJsonWithTimeout(res, GOOGLE_AUTH_API_TIMEOUT_MS);
        if (data.status === 'success' && data.url) {
          window.open(data.url, '_blank');

          let pollCount = 0;
          const interval = setInterval(async () => {
            pollCount++;
            await checkGoogleStatus();

            if (googleStatusBadge && googleStatusBadge.classList.contains('integration-connected')) {
              clearInterval(interval);
              addSystemMessage('Successfully connected to Google Workspace integrations!');
            } else if (pollCount > 150) {
              clearInterval(interval);
              console.warn('Google authentication polling timed out.');
            }
          }, 2000);
        } else {
          throw new Error(data.error || 'Failed to get auth URL');
        }
      } catch (err) {
        console.error('Google auth url error:', err);
        alert(`Google Workspace is not ready to connect: ${err.message}`);
      }
    });
  }

  if (btnCopyRedirectUri && googleRedirectUriDisplay) {
    btnCopyRedirectUri.addEventListener('click', async () => {
      const value = googleRedirectUriDisplay.value || '';
      if (!value || value === 'loading…') return;
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        // Clipboard API can be unavailable; fall back to selecting the field for manual copy.
        googleRedirectUriDisplay.focus();
        googleRedirectUriDisplay.select();
      }
      const original = btnCopyRedirectUri.textContent;
      btnCopyRedirectUri.textContent = 'Copied!';
      setTimeout(() => { btnCopyRedirectUri.textContent = original; }, 1500);
    });
  }

  if (btnSaveGoogleCredentials && inputGoogleClientId && inputGoogleClientSecret) {
    btnSaveGoogleCredentials.addEventListener('click', async () => {
      const clientId = inputGoogleClientId.value.trim();
      const clientSecret = inputGoogleClientSecret.value.trim();
      if (!clientId || !clientSecret) {
        alert('Enter both the Client ID and the Client secret.');
        return;
      }
      const original = btnSaveGoogleCredentials.textContent;
      btnSaveGoogleCredentials.disabled = true;
      btnSaveGoogleCredentials.textContent = 'Saving...';
      try {
        const res = await fetchLocalApiWithTimeout('/api/google/set-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret })
        }, GOOGLE_AUTH_API_TIMEOUT_MS);
        const data = await readBootResponseJsonWithTimeout(res, GOOGLE_AUTH_API_TIMEOUT_MS).catch(() => ({}));
        if (data.status === 'error' || data.error) throw new Error(data.error || 'Failed to save credentials.');
        inputGoogleClientSecret.value = '';
        if (typeof checkGoogleStatus === 'function') checkGoogleStatus();
        alert('Google credentials saved. Now click "Connect Google Account" to sign in.');
      } catch (err) {
        alert('Failed to save Google credentials: ' + (err && err.message ? err.message : 'unknown error'));
      } finally {
        btnSaveGoogleCredentials.disabled = false;
        btnSaveGoogleCredentials.textContent = original;
      }
    });
  }

  if (btnImportGoogleCredentials && inputGoogleCredentialsFile) {
    btnImportGoogleCredentials.addEventListener('click', () => {
      inputGoogleCredentialsFile.click();
    });

    inputGoogleCredentialsFile.addEventListener('change', async () => {
      const file = inputGoogleCredentialsFile.files && inputGoogleCredentialsFile.files[0];
      inputGoogleCredentialsFile.value = '';
      if (!file) return;

      try {
        const text = await file.text();
        JSON.parse(text);

        const res = await fetchLocalApiWithTimeout('/api/google/set-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: text
        }, GOOGLE_AUTH_API_TIMEOUT_MS);

        const data = await readBootResponseJsonWithTimeout(res, GOOGLE_AUTH_API_TIMEOUT_MS).catch(() => ({}));
        if (!res.ok || data.status !== 'success') {
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        addSystemMessage('Google OAuth credentials imported.');
        await checkGoogleStatus();
        alert('Google credentials imported. You can now click Connect Google Account.');
      } catch (err) {
        console.error('Google credentials import failed:', err);
        alert(`Could not import Google credentials: ${err.message}`);
      }
    });
  }

  if (btnDisconnectGoogle) {
    btnDisconnectGoogle.addEventListener('click', async () => {
      try {
        const res = await fetchLocalApiWithTimeout('/api/google/disconnect', { method: 'POST' }, GOOGLE_AUTH_API_TIMEOUT_MS);
        if (res.ok) {
          addSystemMessage('Disconnected from Google Workspace.');
          await checkGoogleStatus();
        } else {
          alert('Failed to disconnect Google account.');
        }
      } catch (err) {
        console.error('Error disconnecting Google:', err);
        alert(`Error: ${err.message}`);
      }
    });
  }

  // Handle outside click to close integrations modal
  window.addEventListener('click', (event) => {
    if (event.target === integrationsModal) {
      integrationsModal.classList.add('hidden');
    }
  });

  // Screen Sharing Logic
  btnShareScreen.addEventListener('click', async () => {
    if (screenStream) {
      stopScreenShare();
    } else {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 } });
        screenVideo.srcObject = screenStream;
        btnShareScreen.classList.add('active');

        // Listen for native "stop sharing" button click
        screenStream.getVideoTracks()[0].onended = () => {
          stopScreenShare();
        };

        // Start capture loop Ã¢â‚¬â€ 1 frame per second
        screenCaptureInterval = setInterval(captureAndSendFrame, 1000);
        addSystemMessage('Screen sharing started. Shadow can now see your screen.');
        signalProactiveAttention('screen_started');
      } catch (err) {
        console.error("Error sharing screen:", err);
        addSystemMessage('Screen sharing cancelled or denied.');
      }
    }
  });

  initWakeWordListener();

  // Start Scheduler Poller
  startSchedulerPoller();

  // Start Visualizer Loop
  requestAnimationFrame(visualizerLoop);
});
