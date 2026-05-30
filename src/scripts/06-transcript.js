/**
 * Shadow AI - Visualizer state updates and transcript rendering helpers.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

// --- Visualizer States ---
function setVisualizerState(state) {
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  const wasSpeaking = currentVisualizerState === 'speaking';
  currentVisualizerState = state;
  updateDiagnosticsPanel();
  if (wasSpeaking && state !== 'speaking' && state !== 'interrupting') {
    flushDeferredSubagentNotifications();
    tryDeliverPendingNotifications();
    if (audioPlayer) {
      audioPlayer.reset();
    }
  }
  switch (state) {
    case 'disconnected':
      visualizerStatus.textContent = `Click Connect to talk to ${assistantLabel}`;
      break;
    case 'connecting':
      visualizerStatus.textContent = 'Opening contact...';
      break;
    case 'listening':
      visualizerStatus.textContent = `${assistantLabel} is listening...`;
      break;
    case 'thinking':
      visualizerStatus.textContent = `${assistantLabel} is thinking...`;
      break;
    case 'speaking':
      visualizerStatus.textContent = `${assistantLabel} is speaking`;
      break;
    case 'interrupting':
      visualizerStatus.textContent = `Interrupting ${assistantLabel}...`;
      break;
  }
}

// --- Transcript Feed Handlers ---
function addSystemMessage(text) {
  const safeText = redactSensitiveText(text);
  if (!SHOW_TEXT_TRANSCRIPT) {
    console.debug('[Shadow notice]', truncateTextForDisplay(safeText, SYSTEM_NOTICE_CONSOLE_LIMIT));
    return;
  }
  appendBubble(truncateTextForDisplay(safeText, SYSTEM_NOTICE_TRANSCRIPT_LIMIT), 'system-bubble');
}

let lastUserPartial = ''; // debounce for Gemini 2.5 tiny chunk spamming

function saveRecentDialogueTurns() {
  try {
    localStorage.setItem(RECENT_DIALOGUE_STORAGE_KEY, JSON.stringify(recentDialogueTurns.slice(-RECENT_DIALOGUE_LIMIT)));
  } catch (err) {
    console.warn('Failed to persist recent dialogue history:', err);
  }
}

function clearRecentDialogueTurns() {
  recentDialogueTurns = [];
  try {
    localStorage.removeItem(RECENT_DIALOGUE_STORAGE_KEY);
  } catch (err) {
    console.warn('Failed to clear recent dialogue history:', err);
  }
}

function rememberDialogueTurn(role, text) {
  const roleText = String(role || '').trim();
  const assistantLabel = typeof getAssistantName === 'function' ? getAssistantName() : 'Shadow';
  const cleanRole = /^(shadow|assistant)$/i.test(roleText) || roleText.toLowerCase() === assistantLabel.toLowerCase() ? 'Assistant' : 'User';
  const clean = sanitizeAITranscriptText(text).trim();
  if (!clean) return;
  const last = recentDialogueTurns[recentDialogueTurns.length - 1];
  if (last && last.role === cleanRole && (clean.startsWith(last.text) || last.text.startsWith(clean))) {
    last.text = clean.length >= last.text.length ? clean : last.text;
    last.at = Date.now();
  } else {
    recentDialogueTurns.push({ role: cleanRole, text: clean, at: Date.now() });
  }
  if (recentDialogueTurns.length > RECENT_DIALOGUE_LIMIT) {
    recentDialogueTurns = recentDialogueTurns.slice(-RECENT_DIALOGUE_LIMIT);
  }
  saveRecentDialogueTurns();
}

function formatRecentDialogueTurns() {
  const assistantLabel = typeof getAssistantRoleLabel === 'function' ? getAssistantRoleLabel() : 'Assistant';
  return recentDialogueTurns
    .slice(-8)
    .map(turn => `${/^(shadow|assistant)$/i.test(turn.role) ? assistantLabel : turn.role}: ${turn.text.slice(0, 260)}`)
    .join('\n');
}

function hasDutchMunicipalityContext(text) {
  const clean = normalizeTranscriptCompare(text);
  return /\b(gemeente|municipality|oss|waste|pass|mailed|mail|ordered|gemeentes)\b/.test(clean);
}

function hasHamantaschenFoodContext(text) {
  const clean = normalizeTranscriptCompare(text);
  return /\b(cookie|cookies|pastry|pastries|dessert|bread|bakery|baking|jewish|purim|jam|poppy|speculoos)\b/.test(clean);
}

function applyUserTranscriptDisplayCorrections(text, contextText = '') {
  let displayText = String(text || '');
  const context = String(contextText || '');

  if (/\b(?:hamentashen|hamantaschen|hamentaschen|hamantashen)\b/i.test(displayText)) {
    const likelyMunicipality = hasDutchMunicipalityContext(`${displayText} ${context}`);
    const likelyFood = hasHamantaschenFoodContext(`${displayText} ${context}`);
    if (likelyMunicipality && !likelyFood) {
      displayText = displayText.replace(/\b(?:hamentashen|hamantaschen|hamentaschen|hamantashen)\b/gi, 'gemeente Oss');
    }
  }

  return displayText.replace(/\bit's\s+it's\b/gi, "it's");
}

function addUserTranscript(text) {
  clearTimeout(userTranscriptTimeout);

  const contextText = recentAIOutputForEcho || (getLastBotBubble() && getLastBotBubble().textContent) || '';
  const displayText = applyUserTranscriptDisplayCorrections(text, contextText);
  const clean = (displayText || '').trim();
  if (!clean) return;
  if (isTinyUserTranscriptRevision(clean)) return;
  lastUserPartial = clean;
  checkWhisperStateToggle(clean);
  userSpeechSeq++;
  clearSystemNoticeInFlight();
  dropStaleNonCriticalNotifications();
  if (shouldHandleUserIntent(clean)) {
    void maybeDirectHandleSubagentUtterance(clean);
    maybeDirectHandleProactiveUtterance(clean);
  }
  // Memory is compiled into the session prompt. Do not inject per-turn memory
  // recall as a fake user turn; stale recall notices caused repeated old replies.
  rememberDialogueTurn('User', clean);

  signalProactiveAttention('user_speech');

  if (!SHOW_TEXT_TRANSCRIPT) {
    currentUserTranscript = displayText;
    userTranscriptTimeout = setTimeout(() => {
      void finalizeCurrentUserTranscriptForMemory();
      currentUserTranscript = '';
      lastUserPartial = '';
    }, 5000);
    return;
  }

  if (!currentUserTranscript) {
    appendBubble(displayText, 'user-bubble', 'current-user-bubble');
    currentUserTranscript = displayText;
  } else {
    const cleanNew = displayText.trim();
    const cleanOld = currentUserTranscript.trim();
    if (cleanNew.toLowerCase().startsWith(cleanOld.toLowerCase())) {
      currentUserTranscript = displayText;
    } else {
      currentUserTranscript = displayText;
    }
    updateLastUserTranscript(currentUserTranscript);
  }

  userTranscriptTimeout = setTimeout(() => {
    void finalizeCurrentUserTranscriptForMemory();
    const bubble = document.querySelector('.current-user-bubble');
    if (bubble) bubble.classList.remove('current-user-bubble');
    currentUserTranscript = '';
    lastUserPartial = '';
  }, 5000);
}

function updateLastUserTranscript(text) {
  const bubble = document.querySelector('.current-user-bubble');
  if (bubble) {
    bubble.textContent = text;
    scrollTranscript();
  }
}

function getLastBotBubble() {
  const bubbles = transcriptFeed ? transcriptFeed.querySelectorAll('.bot-bubble') : [];
  return bubbles.length ? bubbles[bubbles.length - 1] : null;
}

function accumulateAIText(text, options = {}) {
  const { replace = false, allowReplaceLast = false } = options;
  const displayText = sanitizeAITranscriptText(text);
  recentAIOutputForEcho = replace
    ? displayText.slice(-1200)
    : (recentAIOutputForEcho + displayText).slice(-1200);
  if (replace) {
    const bubble = document.querySelector('.current-ai-bubble') || (allowReplaceLast ? getLastBotBubble() : null);
    if (bubble) {
      bubble.textContent = displayText;
      bubble.classList.add('current-ai-bubble');
      currentAITranscript = displayText;
    } else {
      appendBubble(displayText, 'bot-bubble', 'current-ai-bubble');
      currentAITranscript = displayText;
    }
  } else if (!currentAITranscript) {
    appendBubble(displayText, 'bot-bubble', 'current-ai-bubble');
    currentAITranscript = displayText;
  } else {
    currentAITranscript += displayText;
    updateLastAITranscript(currentAITranscript);
  }

  // The bubble's '.current-ai-bubble' class is removed natively by the server's 'turnComplete' event.
}

function sanitizeAITranscriptText(text) {
  return redactSensitiveText(String(text || '')
    .replace(/\*{1,3}([^*\n]+?)\*{1,3}/g, '$1')
    .replace(/\*/g, '')
    .replace(/\s+([.,!?;:])/g, '$1'));
}

function normalizeTranscriptCompare(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function transcriptJoiner(base, incoming) {
  if (!base || /[\s("']$/.test(base)) return '';
  if (/^[\s.,!?;:)'"-]/.test(incoming)) return '';
  return ' ';
}

function mergeOutputTranscription(text) {
  const incoming = String(text || '').trim();
  if (!incoming) return;

  const incomingNorm = normalizeTranscriptCompare(incoming);
  const lastNorm = normalizeTranscriptCompare(lastOutputTranscriptionText);
  if (incomingNorm && incomingNorm === lastNorm) return;

  const lastBot = getLastBotBubble();
  const lateWindowOpen = lastAITurnCompleteTime > 0 && (Date.now() - lastAITurnCompleteTime) < LATE_TRANSCRIPTION_WINDOW_MS;
  const base = currentAITranscript || (lateWindowOpen && lastBot ? (lastBot.textContent || '') : '');
  const baseNorm = normalizeTranscriptCompare(base);

  if (!baseNorm) {
    lastOutputTranscriptionText = incoming;
    accumulateAIText(incoming, { replace: true, allowReplaceLast: false });
    return;
  }

  // Some models send cumulative ASR text; use it if it clearly contains the current transcript.
  const basePrefix = baseNorm.substring(0, Math.min(baseNorm.length, 80));
  if (incoming.length > base.length && basePrefix && incomingNorm.includes(basePrefix)) {
    lastOutputTranscriptionText = incoming;
    accumulateAIText(incoming, { replace: true, allowReplaceLast: Boolean(currentAITranscript) || lateWindowOpen });
    return;
  }

  // If modelTurn.parts already gave us text, short ASR chunks are usually deltas.
  // Appending them creates garbled/repeated text like "new Good ... found".
  if (currentAITranscriptHasModelText) {
    lastOutputTranscriptionText = incoming;
    return;
  }

  // Other models send short ASR deltas. Do not let the last tiny chunk replace the full bubble.
  if (baseNorm.endsWith(incomingNorm) || baseNorm.includes(incomingNorm)) {
    lastOutputTranscriptionText = incoming;
    return;
  }

  const merged = `${base}${transcriptJoiner(base, incoming)}${incoming}`;
  lastOutputTranscriptionText = incoming;
  accumulateAIText(merged, { replace: true, allowReplaceLast: Boolean(currentAITranscript) || lateWindowOpen });
}

function updateLastAITranscript(text) {
  const bubble = document.querySelector('.current-ai-bubble');
  if (bubble) {
    bubble.textContent = sanitizeAITranscriptText(text);
    scrollTranscript();
  }
}

function appendBubble(text, className, idName = '') {
  if (!SHOW_TEXT_TRANSCRIPT || !transcriptFeed) return null;
  const bubble = document.createElement('div');
  bubble.className = `transcript-bubble ${className}`;
  if (idName) bubble.classList.add(idName);
  bubble.textContent = text;
  transcriptFeed.appendChild(bubble);
  scrollTranscript();
  return bubble;
}

function scrollTranscript() {
  if (!SHOW_TEXT_TRANSCRIPT) return;
  const container = document.querySelector('.transcript-container');
  if (!container) return;
  container.scrollTop = container.scrollHeight;
}
