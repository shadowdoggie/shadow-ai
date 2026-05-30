/**
 * Shadow AI - REST subagent execution loop and tool orchestration.
 * Split from the original monolithic app.js; loaded as an ordered classic script.
 */

function hasReusableLearningArtifact(subagentRecord) {
  return Boolean(subagentRecord && subagentRecord.savedSkill);
}

function getLearningRequirementMessage(task, subagentRecord) {
  const mediaHint = isMediaDownloadTask(task)
    ? 'For this media download workflow, save a reusable skill documenting the verified yt-dlp command path with strict title matching and no browser automation.'
    : 'Create or merge a skill that captures the reusable workflow.';
  const checks = [];
  if (!subagentRecord.checkedSkills) checks.push('get_available_skills');
  const checkHint = checks.length > 0 ? ` First call ${checks.join(' and ')} to avoid duplicates.` : '';
  return `This was a repeatable successful task, but no reusable skill was saved or reused.${checkHint} ${mediaHint} If a similar skill exists, merge your new steps into that existing skill instead of creating a duplicate, then call finish_task again.`;
}

async function runSubagentPowerShellCommand(subagentRecord, command, timeoutMs, label = 'powershell') {
  const commandId = createSubagentBackendCommandId(subagentRecord, label);
  trackSubagentBackendCommand(subagentRecord, commandId);
  try {
    const res = await fetchWithTimeout('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, timeout_ms: timeoutMs, command_id: commandId })
    }, timeoutMs, subagentRecord);
    return await readFetchResponseJsonWithTimeout(res, timeoutMs, subagentRecord);
  } catch (err) {
    const reason = String(err && err.message || err || 'command failed');
    if (typeof cancelShadowBackendCommand === 'function' && /cancelled|timed out|timeout|abort|failed to fetch|network/i.test(reason)) {
      await cancelShadowBackendCommand(commandId, reason);
    }
    throw err;
  } finally {
    untrackSubagentBackendCommand(subagentRecord, commandId);
  }
}

async function runNormalizedSubagentPowerShellCommand(subagentRecord, command, timeoutMs, label = 'powershell') {
  try {
    const rawJson = await runSubagentPowerShellCommand(subagentRecord, command, timeoutMs, label);
    return typeof normalizeLivePowerShellCommandResult === 'function'
      ? normalizeLivePowerShellCommandResult(command, rawJson)
      : rawJson;
  } catch (err) {
    if (typeof normalizeLivePowerShellCommandResult !== 'function') throw err;
    const normalized = normalizeLivePowerShellCommandResult(command, {
      output: `Execution transport ended while waiting for command result: ${err && err.message ? err.message : String(err)}`,
      error: err && err.message ? err.message : String(err),
      status: 'error',
      transport_error: true
    });
    if (normalized && normalized.assumed_success) {
      if (typeof rememberAssumedDisruptiveCommand === 'function') {
        rememberAssumedDisruptiveCommand(command, normalized);
      }
      return normalized;
    }
    throw err;
  }
}

function withShadowBackendRequestMetadata(options = {}, requestId, timeoutMs) {
  if (!requestId || typeof options.body !== 'string') return options;
  try {
    const body = JSON.parse(options.body);
    body.request_id = requestId;
    body.timeout_ms = timeoutMs;
    return { ...options, body: JSON.stringify(body) };
  } catch {
    return options;
  }
}

async function fetchSubagentBackendModelRequest(subagentRecord, url, options, timeoutMs, label = 'model') {
  const requestId = createSubagentBackendRequestId(subagentRecord, label);
  trackSubagentBackendRequest(subagentRecord, requestId);
  try {
    const requestOptions = withShadowBackendRequestMetadata(options, requestId, timeoutMs);
    return await fetchWithTimeout(url, requestOptions, timeoutMs, subagentRecord);
  } catch (err) {
    if (typeof cancelShadowBackendRequest === 'function' && /cancelled|timed out|abort/i.test(String(err && err.message || err))) {
      cancelShadowBackendRequest(requestId, String(err && err.message || err));
    }
    throw err;
  } finally {
    untrackSubagentBackendRequest(subagentRecord, requestId);
  }
}

function toReusableName(text, fallback = 'repeatable_workflow') {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'onto', 'this', 'that', 'please', 'task', 'file']);
  const usable = words.filter(word => word.length > 2 && !stopWords.has(word)).slice(0, 6);
  return (usable.length ? usable.join('_') : fallback).replace(/[^a-z0-9_]/g, '_');
}

function createCodexResponsesContent(parts, role = 'user') {
  const content = [];
  for (const part of parts || []) {
    if (part.text) {
      content.push({
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: part.text
      });
    }
    if (role !== 'assistant' && part.inlineData && part.inlineData.data) {
      content.push({
        type: 'input_image',
        image_url: `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data}`
      });
    }
  }
  return content;
}

function getCodexSubagentReasoning(targetModel) {
  if (!OPENAI_CODEX_REASONING_MODELS.has(targetModel)) return null;
  const requested = OPENAI_CODEX_REASONING_MODES.has(subagentReasoningMode) ? subagentReasoningMode : 'medium';
  if (requested === 'none') return null;

  // Shadow subagents are tool-loop workers. Very high reasoning tends to slow
  // them down and makes them more likely to narrate instead of acting.
  const capped = requested === 'high' || requested === 'xhigh' ? 'medium' : requested;
  return { effort: capped, summary: 'auto' };
}

function buildCodexSubagentInstructions(subagentSystemInstruction, webSearchCheckpoint = 8) {
  const searchCheckpoint = Math.max(1, Number(webSearchCheckpoint) || 8);
  const codexHardSearchLimit = Math.max(4, Math.min(searchCheckpoint, 12));
  return `${subagentSystemInstruction}

CODEX SUBAGENT TOOL LOOP:
- You are not in a chat conversation. You are inside Shadow's background tool loop.
- Every assistant turn MUST do exactly one of these: call one tool, call request_user_auth_checkpoint, or call finish_task.
- Do NOT make multiple tool calls in one response. Wait for each tool result before deciding the next action.
- Do NOT answer in prose while work remains. Prose is only acceptable inside finish_task summary fields.
- Prefer the smallest verifiable next action. Inspect exact state, perform one change, verify, then finish.
- If a tool fails twice or the task is blocked, switch approach once. Then call finish_task with status="partial" or status="failed" instead of looping.
- If the user asked for coding, editing, files, downloads, uploads, or browser work, use tools to actually do it. Do not merely explain how to do it.
- Web research is deliberately bounded for Codex subagents: use at most one web_search per assistant turn, avoid equivalent query rewrites, and stop after ${codexHardSearchLimit} total web_search calls for this task. Once enough evidence exists or the limit is reached, synthesize from gathered results and call finish_task. Do not use PowerShell web scraping to bypass this limit.
- After any successful repeatable automation/download/build workflow, satisfy the skill-learning rule before finish_task(status="success").`;
}

function getPlainTextFinishRepairPrompt(provider, textResponse) {
  const excerpt = String(textResponse || '').trim().slice(0, 1200);
  if (provider === OPENAI_CODEX_PROVIDER) {
    return `Your previous response was plain text, but Shadow subagents can only progress by tool calls. Next response must be exactly one tool call: either continue with the single next useful tool call, or call finish_task with the correct status. Do not include prose outside the tool call. Previous plain text:\n${excerpt}`;
  }
  return `You must finalize by calling finish_task. Do not answer in plain text. Your previous text was: ${excerpt}`;
}

function looksLikeUsableCodexPlainTextFinal(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 40) return false;
  return !/\b(i need to|i should|i will|i'll|next i|need more|continue searching|search again|not enough|cannot answer yet|can't answer yet|need to verify|need to check)\b/i.test(clean);
}

function maybeFinalizeCodexPlainTextResponse(task, subagentRecord, textResponse, plainTextRepairCount = 0) {
  if (!subagentRecord || !isOpenAiCodexSubagentProvider(subagentRecord.provider)) return false;
  const clean = String(textResponse || '').trim();
  if (!clean) return false;
  const evidence = typeof getSubagentEvidenceSummary === 'function'
    ? getSubagentEvidenceSummary(subagentRecord, 6)
    : '';
  if (!evidence) return false;

  const usefulFinal = looksLikeUsableCodexPlainTextFinal(clean);
  if (!usefulFinal && plainTextRepairCount < 2) return false;

  const verification = evidence || 'Completed with prior tool evidence.';
  const finalText = `${clean}\n\nVerification: ${verification}`;
  if (usefulFinal) {
    completeSubagentRecord(subagentRecord, finalText);
    renderSubagentFinalBubble('Subagent Completed', task, finalText);
    notifyVoiceSession(task, finalText, subagentRecord.id);
    addSubagentMessage('Codex plain-text final answer auto-wrapped as completed finish_task.');
  } else {
    const reason = 'Codex returned repeated plain text instead of finish_task after tool evidence; stopped the loop and preserved the best available answer.';
    partialSubagentRecord(subagentRecord, finalText, reason);
    renderSubagentFinalBubble('Subagent Partially Completed', task, finalText);
    notifyVoiceSessionOfPartial(task, reason, subagentRecord.id);
    addSubagentMessage('Codex repeated plain text instead of finish_task; marked partial to stop loop.');
  }
  return true;
}

function getSubagentTimeoutAssessment(subagentRecord, now = Date.now()) {
  if (!subagentRecord) return null;
  const hardTimeoutMs = typeof SUBAGENT_TASK_HARD_TIMEOUT_MS === 'number'
    ? SUBAGENT_TASK_HARD_TIMEOUT_MS
    : 6 * 60 * 60 * 1000;
  const startedAtMs = Date.parse(subagentRecord.startedAt || '');
  const startedAt = Number.isFinite(startedAtMs) ? startedAtMs : now;
  const elapsedMs = now - startedAt;
  if (elapsedMs <= hardTimeoutMs) return null;
  const minutes = Math.round(hardTimeoutMs / 60000);
  return {
    timedOut: true,
    kind: 'hard',
    message: `Task exceeded ${minutes} minute hard limit.`
  };
}

function getSubagentToolCallKey(call) {
  if (!call) return '';
  return String(call.id || call.name || '').trim();
}

function appendInterruptedSubagentToolResponses(history, functionCalls = [], answeredCallIds = new Set(), collectedParts = []) {
  const parts = Array.isArray(collectedParts) ? collectedParts.slice() : [];
  for (const part of functionCalls || []) {
    const call = part && part.functionCall ? part.functionCall : part;
    const key = getSubagentToolCallKey(call);
    if (key && answeredCallIds && answeredCallIds.has(key)) continue;
    if (!call || !call.name) continue;
    parts.push({
      functionResponse: {
        name: call.name,
        id: call.id,
        response: {
          status: 'interrupted',
          error: 'Tool call interrupted by user correction before completion.',
          next_action_required: 'Continue by incorporating the queued user correction. Do not treat this as task failure.'
        }
      }
    });
  }
  if (parts.length === 0) return false;
  history.push({ role: 'user', parts });
  return true;
}

function normalizeSubagentSearchQuery(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:the|a|an|and|or|for|with|new|price|prices|best|lowest|latest|2026)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function isCurrentSourceSensitiveResearchTask(text) {
  const normalized = String(text || '').toLowerCase();
  const sourceSensitiveTarget = /\b(vacation|holiday|trip|travel|flight|flights|hotel|hotels|hostel|hostels|airbnb|accommodation|itinerary|booking|bookings|buy|purchase|shop|shopping|product|products|laptop|computer|pc|gpu|phone|monitor|camera|car|vehicle|apartment|rental|rent|house|home|restaurant|restaurants|bar|venue|event|events|concert|ticket|tickets|doctor|dentist|clinic|insurance|loan|mortgage|course|class|provider|subscription|deal|deals|offer|offers|option|options|recommendation|recommendations|faro|portugal|algarve)\b/.test(normalized);
  const currentResearchSignal = /\b(next week|tomorrow|today|this week|near me|open now|in stock|january|february|march|april|may|june|july|august|september|october|november|december|under|budget|cheap|cheapest|best|top|availability|available|booking|book|price|prices|prijs|cost|costs|rate|rates|quote|quotes|euro|euros|eur|deal|deals|discount|sale|stock|review|reviews|\d{3,5}|202[6-9]|20[3-9]\d)\b/.test(normalized)
    || /[€$£]/.test(normalized);
  return sourceSensitiveTarget && currentResearchSignal;
}

function isCurrentTravelPlanningTask(text) {
  const normalized = String(text || '').toLowerCase();
  const hasTravelIntent = /\b(vacation|holiday|trip|travel|flight|flights|hotel|hotels|hostel|hostels|airbnb|accommodation|itinerary|booking|bookings|faro|portugal|algarve)\b/.test(normalized);
  return hasTravelIntent && isCurrentSourceSensitiveResearchTask(text);
}

function getSubagentWebSearchCheckpoint(provider, task = '') {
  const normalized = String(task || '').toLowerCase();
  if (isCurrentSourceSensitiveResearchTask(task)) {
    if (/\b(compare|comparison|options|itinerary|plan|recommendations?|best|top|cheapest|under|budget|reviews?|availability|available|in stock|booking|book|multi-city|multiple|several|list)\b/.test(normalized)) {
      return 24;
    }
    return 16;
  }
  if (/\b(research|investigate|compare|comparison|find sources?|source-backed|cite|citations?|options|alternatives|recommendations?|market|prices?|reviews?)\b/.test(normalized)) {
    return 12;
  }
  return 8;
}

function isOpenAiCodexSubagentProvider(provider) {
  const codexProvider = typeof OPENAI_CODEX_PROVIDER === 'undefined' ? 'openai_codex' : OPENAI_CODEX_PROVIDER;
  return provider === codexProvider;
}

function isResearchLikeSubagentTask(text) {
  const normalized = String(text || '').toLowerCase();
  return isCurrentSourceSensitiveResearchTask(normalized)
    || /\b(research|investigate|compare|comparison|find|look up|look for|source-backed|cite|citation|benchmark|benchmarks|performance|tokens?\s*\/?\s*s|tok\/s|t\/s|llama-bench|lm studio|gpu|cpu|price|prices|reviews?|recommendations?|options?|best|top|availability|available|in stock)\b/.test(normalized);
}

function getSubagentWebSearchHardLimit(provider, task = '') {
  if (!isOpenAiCodexSubagentProvider(provider)) return null;
  const checkpoint = getSubagentWebSearchCheckpoint(provider, task);
  if (isCurrentSourceSensitiveResearchTask(task)) return Math.min(checkpoint, 12);
  if (isResearchLikeSubagentTask(task)) return Math.min(checkpoint, 8);
  return Math.min(checkpoint, 6);
}

function isPowerShellWebFetchCommand(command) {
  const text = String(command || '').toLowerCase();
  return /\b(invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget|start-bitstransfer)\b/.test(text)
    || /https?:\/\//i.test(text);
}

function getCodexResearchExhaustedPrompt(checkpoint) {
  checkpoint = checkpoint || {};
  const count = checkpoint.count || 0;
  const limit = checkpoint.hard_limit || checkpoint.checkpoint || 0;
  return `[SYSTEM] Codex research budget reached (${count}/${limit} web_search calls). Do not call web_search again and do not use PowerShell/curl/Invoke-WebRequest to scrape around the limit. Synthesize from the gathered results now. If evidence is insufficient, call finish_task with status="partial" and state the exact gap.`;
}

function shouldBlockCodexResearchPowerShellWebFetch(subagentRecord, command, provider) {
  if (!isOpenAiCodexSubagentProvider(provider)) return false;
  if (!isPowerShellWebFetchCommand(command)) return false;
  const task = subagentRecord && subagentRecord.task ? subagentRecord.task : '';
  if (!isResearchLikeSubagentTask(task)) return false;
  return (Number(subagentRecord && subagentRecord.webSearchCount) || 0) > 0;
}

function reserveSubagentWebSearch(subagentRecord, query, provider) {
  const limitContext = `${subagentRecord && subagentRecord.task ? subagentRecord.task : ''}\n${query || ''}`;
  if (!subagentRecord) {
    const checkpoint = getSubagentWebSearchCheckpoint(provider, limitContext);
    const hardLimit = getSubagentWebSearchHardLimit(provider, limitContext);
    return { ok: true, count: 1, checkpoint, normal_checkpoint: checkpoint, hard_limit: hardLimit, searches_before_checkpoint: null, searches_before_hard_limit: hardLimit ? Math.max(0, hardLimit - 1) : null, past_normal_checkpoint: false, hard_limit_reached: Boolean(hardLimit && hardLimit <= 1) };
  }
  const checkpoint = getSubagentWebSearchCheckpoint(provider, limitContext);
  const hardLimit = getSubagentWebSearchHardLimit(provider, subagentRecord.task || limitContext);
  const normalized = normalizeSubagentSearchQuery(query);
  subagentRecord.webSearchCount = Number(subagentRecord.webSearchCount) || 0;
  subagentRecord.webSearchQueries = Array.isArray(subagentRecord.webSearchQueries) ? subagentRecord.webSearchQueries : [];
  if (normalized && subagentRecord.webSearchQueries.includes(normalized)) {
    return {
      ok: false,
      kind: 'duplicate_query',
      count: subagentRecord.webSearchCount,
      checkpoint,
      normal_checkpoint: checkpoint,
      hard_limit: hardLimit,
      reason: 'Repeated equivalent web_search query blocked.'
    };
  }
  if (hardLimit && subagentRecord.webSearchCount >= hardLimit) {
    return {
      ok: false,
      kind: 'hard_limit',
      count: subagentRecord.webSearchCount,
      checkpoint,
      normal_checkpoint: checkpoint,
      hard_limit: hardLimit,
      reason: `Codex web_search hard limit reached (${subagentRecord.webSearchCount}/${hardLimit}).`
    };
  }
  subagentRecord.webSearchCount += 1;
  if (normalized) subagentRecord.webSearchQueries.push(normalized);
  const pastNormalCheckpoint = subagentRecord.webSearchCount > checkpoint;
  const hardLimitReached = Boolean(hardLimit && subagentRecord.webSearchCount >= hardLimit);
  return {
    ok: true,
    count: subagentRecord.webSearchCount,
    checkpoint,
    normal_checkpoint: checkpoint,
    hard_limit: hardLimit,
    searches_before_checkpoint: Math.max(0, checkpoint - subagentRecord.webSearchCount),
    searches_before_hard_limit: hardLimit ? Math.max(0, hardLimit - subagentRecord.webSearchCount) : null,
    past_normal_checkpoint: pastNormalCheckpoint,
    hard_limit_reached: hardLimitReached,
    warning: hardLimitReached
      ? `Codex web_search hard limit reached (${subagentRecord.webSearchCount}/${hardLimit}); synthesize and finish now.`
      : (pastNormalCheckpoint ? `Past the normal web_search evidence checkpoint (${subagentRecord.webSearchCount}/${checkpoint}); continue only if this task still needs more evidence.` : '')
  };
}

function getWebSearchCheckpointGuidancePrompt(checkpoint) {
  if (checkpoint && checkpoint.kind === 'duplicate_query') {
    return `[SYSTEM] ${checkpoint.reason} Do not repeat equivalent web_search queries. Use a meaningfully different query if more evidence is needed, otherwise synthesize from the evidence already gathered.`;
  }
  if (checkpoint && checkpoint.kind === 'hard_limit') {
    return getCodexResearchExhaustedPrompt(checkpoint);
  }
  if (checkpoint && checkpoint.hard_limit_reached) {
    return getCodexResearchExhaustedPrompt(checkpoint);
  }
  return `[SYSTEM] ${checkpoint && checkpoint.reason ? checkpoint.reason : 'Web search evidence checkpoint reached.'} This is not a hard stop. Continue searching only if the task still needs more current evidence; otherwise synthesize from gathered sources and finish.`;
}

function getWebSearchBatchBlockedPrompt() {
  return '[SYSTEM] Only one web_search may run per assistant turn. Do not batch multiple searches. Use the first result set, then choose one next action or finish.';
}

function createChatCompletionsMessages(history, subagentSystemInstruction) {
  const openAiMessages = [{ role: 'system', content: subagentSystemInstruction }];
  const pendingCalls = [];

  for (let msgIdx = 0; msgIdx < history.length; msgIdx++) {
    const msg = history[msgIdx];

    if (msg.role === 'model') {
      const parts = msg.parts || [];
      const toolCalls = [];
      let text = '';

      for (let partIdx = 0; partIdx < parts.length; partIdx++) {
        const part = parts[partIdx];
        if (part.text) text += part.text;
        if (part.functionCall) {
          if (!part.functionCall.id) {
            part.functionCall.id = `call_${msgIdx}_${partIdx}_${Math.random().toString(36).substr(2, 5)}`;
          }
          pendingCalls.push({ name: part.functionCall.name, id: part.functionCall.id });
          toolCalls.push({
            id: part.functionCall.id,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {})
            }
          });
        }
      }

      if (toolCalls.length > 0) {
        openAiMessages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
      } else {
        openAiMessages.push({ role: 'assistant', content: text || null });
      }
      continue;
    }

    const parts = msg.parts || [];
    const isToolResponseTurn = parts.some(part => part.functionResponse);

    if (isToolResponseTurn) {
      const toolResultImages = [];
      for (let partIdx = 0; partIdx < parts.length; partIdx++) {
        const part = parts[partIdx];
        if (part.functionResponse) {
          let matchingCallIdx = -1;
          for (let c = pendingCalls.length - 1; c >= 0; c--) {
            if (pendingCalls[c].name === part.functionResponse.name) {
              matchingCallIdx = c;
              break;
            }
          }

          let callId = `call_unknown_${msgIdx}_${partIdx}`;
          if (part.functionResponse.id) {
            callId = part.functionResponse.id;
          } else if (matchingCallIdx >= 0) {
            callId = pendingCalls[matchingCallIdx].id;
            pendingCalls.splice(matchingCallIdx, 1);
          }

          openAiMessages.push({
            role: 'tool',
            tool_call_id: callId,
            name: part.functionResponse.name,
            content: JSON.stringify(part.functionResponse.response)
          });
        } else if (part.inlineData && part.inlineData.data) {
          toolResultImages.push({
            type: 'image_url',
            image_url: { url: `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data}` }
          });
        }
      }
      if (toolResultImages.length > 0) {
        openAiMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Visual output from the previous browser/tool call. Use this screenshot to inspect the page and choose the next action.' },
            ...toolResultImages
          ]
        });
      }
      continue;
    }

    const content = [];
    for (const part of parts) {
      if (part.text) content.push({ type: 'text', text: part.text });
      if (part.inlineData && part.inlineData.data) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data}` }
        });
      }
    }
    if (content.length === 1 && content[0].type === 'text') {
      openAiMessages.push({ role: 'user', content: content[0].text });
    } else if (content.length > 0) {
      openAiMessages.push({ role: 'user', content });
    }
  }

  return openAiMessages;
}

function createCodexResponsesPayload(history, subagentSystemInstruction, subagentTools, targetModel, webSearchCheckpoint = 8) {
  const input = [];
  const pendingCalls = [];

  for (let msgIdx = 0; msgIdx < history.length; msgIdx++) {
    const msg = history[msgIdx];
    const parts = msg.parts || [];

    if (msg.role === 'model') {
      const codexResponseItems = Array.isArray(msg._codexResponseItems) ? msg._codexResponseItems : [];
      if (codexResponseItems.length > 0) {
        for (let itemIdx = 0; itemIdx < codexResponseItems.length; itemIdx++) {
          const sourceItem = codexResponseItems[itemIdx];
          if (!sourceItem || typeof sourceItem !== 'object') continue;
          const item = JSON.parse(JSON.stringify(sourceItem));
          if (item.type === 'function_call') {
            if (!item.call_id) item.call_id = item.id || `call_${msgIdx}_${itemIdx}_${Math.random().toString(36).substr(2, 5)}`;
            if (typeof item.arguments !== 'string') item.arguments = JSON.stringify(item.arguments || {});
            pendingCalls.push({ name: item.name, id: item.call_id });
          }
          input.push(item);
        }
        continue;
      }

      const textParts = parts.filter(part => part.text);
      const assistantContent = createCodexResponsesContent(textParts, 'assistant');
      if (assistantContent.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: assistantContent });
      }
      for (let partIdx = 0; partIdx < parts.length; partIdx++) {
        const part = parts[partIdx];
        if (!part.functionCall) continue;
        if (!part.functionCall.id) {
          part.functionCall.id = `call_${msgIdx}_${partIdx}_${Math.random().toString(36).substr(2, 5)}`;
        }
        pendingCalls.push({ name: part.functionCall.name, id: part.functionCall.id });
        input.push({
          type: 'function_call',
          call_id: part.functionCall.id,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {})
        });
      }
      continue;
    }

    const isToolResponseTurn = parts.some(part => part.functionResponse);
    if (isToolResponseTurn) {
      const visualParts = [];
      for (let partIdx = 0; partIdx < parts.length; partIdx++) {
        const part = parts[partIdx];
        if (part.functionResponse) {
          let matchingCallIdx = -1;
          for (let c = pendingCalls.length - 1; c >= 0; c--) {
            if (pendingCalls[c].name === part.functionResponse.name) {
              matchingCallIdx = c;
              break;
            }
          }

          let callId = `call_unknown_${msgIdx}_${partIdx}`;
          if (part.functionResponse.id) {
            callId = part.functionResponse.id;
          } else if (matchingCallIdx >= 0) {
            callId = pendingCalls[matchingCallIdx].id;
            pendingCalls.splice(matchingCallIdx, 1);
          }

          input.push({
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(part.functionResponse.response)
          });
        } else if (part.inlineData && part.inlineData.data) {
          visualParts.push(part);
        }
      }
      if (visualParts.length > 0) {
        input.push({
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Visual output from the previous browser/tool call. Use this screenshot to inspect the page and choose the next action.' },
            ...createCodexResponsesContent(visualParts, 'user')
          ]
        });
      }
      continue;
    }

    const userContent = createCodexResponsesContent(parts, 'user');
    if (userContent.length > 0) {
      input.push({ type: 'message', role: 'user', content: userContent });
    }
  }

  const tools = [];
  if (subagentTools && subagentTools[0] && subagentTools[0].functionDeclarations) {
    for (const tool of subagentTools[0].functionDeclarations) {
      tools.push({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: convertSchemaTypesToLowercase(tool.parameters)
      });
    }
  }

  const reasoning = getCodexSubagentReasoning(targetModel);

  return {
    model: targetModel || 'gpt-5.5',
    instructions: buildCodexSubagentInstructions(subagentSystemInstruction, webSearchCheckpoint),
    input,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning,
    store: false,
    stream: true,
    include: reasoning ? ['reasoning.encrypted_content'] : [],
    prompt_cache_key: 'shadow-ai-subagents',
    client_metadata: {
      'x-codex-installation-id': 'shadow-ai'
    }
  };
}

function parseCodexResponsesSseToGemini(sseText) {
  const outputItemsByIndex = new Map();
  const outputItemOrder = [];
  let textDeltaBuffer = '';

  function getOutputKey(event) {
    if (event && event.output_index !== undefined && event.output_index !== null) return String(event.output_index);
    if (event && event.item_id) return `id:${event.item_id}`;
    return `idx:${outputItemOrder.length}`;
  }

  function rememberOutputItem(event, item) {
    if (!item || typeof item !== 'object') return null;
    const key = getOutputKey(event);
    if (!outputItemsByIndex.has(key)) outputItemOrder.push(key);
    const cloned = JSON.parse(JSON.stringify(item));
    if (cloned.type === 'function_call' && typeof cloned.arguments !== 'string') {
      cloned.arguments = JSON.stringify(cloned.arguments || {});
    }
    outputItemsByIndex.set(key, cloned);
    return cloned;
  }

  function findFunctionCallItem(event) {
    const directKey = getOutputKey(event);
    const directItem = outputItemsByIndex.get(directKey);
    if (directItem && directItem.type === 'function_call') return directItem;
    if (event && event.item_id) {
      for (const item of outputItemsByIndex.values()) {
        if (item && item.id === event.item_id && item.type === 'function_call') return item;
      }
    }
    return null;
  }

  for (const line of String(sseText || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;

    try {
      const event = JSON.parse(data);
      if (event.type === 'response.output_text.delta' && event.delta) {
        textDeltaBuffer += event.delta;
      }
      if (event.type === 'response.output_item.added' && event.item) {
        rememberOutputItem(event, event.item);
      }
      if (event.type === 'response.function_call_arguments.delta' && event.delta) {
        const item = findFunctionCallItem(event);
        if (item) item.arguments = `${item.arguments || ''}${event.delta}`;
      }
      if (event.type === 'response.function_call_arguments.done' && event.arguments !== undefined) {
        let item = findFunctionCallItem(event);
        if (!item) {
          item = rememberOutputItem(event, {
            type: 'function_call',
            id: event.item_id,
            call_id: event.call_id || event.item_id,
            name: event.name,
            arguments: ''
          });
        }
        if (item) {
          if (event.name && !item.name) item.name = event.name;
          if (event.call_id && !item.call_id) item.call_id = event.call_id;
          item.arguments = event.arguments;
        }
      }
      if (event.type === 'response.output_item.done' && event.item) {
        rememberOutputItem(event, event.item);
      }
      if (event.type === 'response.completed' && event.response && Array.isArray(event.response.output)) {
        event.response.output.forEach((item, output_index) => rememberOutputItem({ output_index }, item));
      }
    } catch (err) {
      console.warn('[Codex Responses] Ignoring malformed SSE event:', err);
    }
  }

  const outputItems = outputItemOrder
    .map(key => outputItemsByIndex.get(key))
    .filter(Boolean);

  const parts = [];
  for (const item of outputItems) {
    if (item.type === 'message') {
      const text = (item.content || [])
        .filter(contentPart => (contentPart.type === 'output_text' && contentPart.text) || (contentPart.type === 'refusal' && contentPart.refusal))
        .map(contentPart => contentPart.text || contentPart.refusal)
        .join('\n')
        .trim();
      if (text) parts.push({ text });
    } else if (item.type === 'function_call') {
      let args = {};
      try { args = JSON.parse(item.arguments || '{}'); } catch (err) {}
      parts.push({
        functionCall: {
          name: item.name,
          args,
          id: item.call_id || item.id
        }
      });
    }
  }

  if (parts.length === 0 && textDeltaBuffer.trim()) {
    parts.push({ text: textDeltaBuffer.trim() });
  }

  return { candidates: [{ content: { parts } }], codexResponseItems: outputItems };
}

async function ensureReusableLearningArtifact(task, subagentRecord, finalText) {
  if (!isRepeatableLearningTask(task) || hasReusableLearningArtifact(subagentRecord)) return { status: 'skipped' };

  const skillName = `workflow_${toReusableName(task)}`;
  const instructions = `Reusable workflow learned from successful task.\n\nTask: ${task}\n\nOutcome / verification:\n${finalText || 'Completed successfully.'}\n\nImportant: Before repeating, inspect current page/files/state and avoid stale selectors or assumptions.`;
  const res = await fetchWithTimeout('/api/skills/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill_name: skillName, instructions })
  }, SUBAGENT_TOOL_TIMEOUT_MS, subagentRecord);
  const result = await readFetchResponseJsonWithTimeout(res, SUBAGENT_TOOL_TIMEOUT_MS, subagentRecord);
  if (result.status !== 'success') throw new Error(result.error || 'Failed to auto-save reusable skill.');
  subagentRecord.checkedSkills = true;
  subagentRecord.savedSkill = true;
  addSubagentMessage(`Auto-saved reusable skill: ${result.skill_name || result.merged_into || skillName}`);
  return result;
}

function getOllamaLocalBase() {
  const ep = (typeof ollamaLocalEndpoint !== 'undefined' && ollamaLocalEndpoint) ? ollamaLocalEndpoint : 'http://localhost:11434';
  return String(ep).replace(/\/+$/, '');
}

// User-chosen context window for local Ollama. Smaller = faster load + less VRAM.
function getOllamaLocalNumCtx() {
  const n = (typeof ollamaLocalNumCtx !== 'undefined') ? parseInt(ollamaLocalNumCtx, 10) : NaN;
  return (!isNaN(n) && n >= 512) ? n : 8192;
}

// Extra options sent to local Ollama on every call: bound the context window (the big
// lever for load time/VRAM) and keep the model warm so back-to-back calls don't reload it.
function getOllamaLocalRequestExtras() {
  return { options: { num_ctx: getOllamaLocalNumCtx() }, keep_alive: '30m' };
}

function getSmartConsultModel() {
  const codexProvider = typeof OPENAI_CODEX_PROVIDER === 'undefined' ? 'openai_codex' : OPENAI_CODEX_PROVIDER;
  const provider = typeof subagentProvider === 'undefined' ? codexProvider : subagentProvider;
  const configuredModel = typeof subagentModel === 'undefined' ? '' : subagentModel;
  if (provider === codexProvider) {
    return OPENAI_CODEX_REASONING_MODELS.has(configuredModel) ? configuredModel : 'gpt-5.5';
  }
  if (provider === 'gemini') {
    const requested = configuredModel || 'models/gemini-3.1-flash-lite';
    return requested.startsWith('models/') ? requested : `models/${requested}`;
  }
  if (provider === 'minimax') return configuredModel || 'minimax-m2.7';
  if (provider === 'moonshot') return configuredModel || 'moonshotai/kimi-k2.6';
  if (provider === 'ollama') return configuredModel || 'deepseek-v3.1:671b-cloud';
  if (provider === 'ollama_local') return configuredModel || '';
  return configuredModel || 'gpt-5.5';
}

function getSmartConsultProvider() {
  const codexProvider = typeof OPENAI_CODEX_PROVIDER === 'undefined' ? 'openai_codex' : OPENAI_CODEX_PROVIDER;
  return (typeof subagentProvider === 'undefined' || !subagentProvider)
    ? codexProvider
    : subagentProvider;
}

function getCodexSmartConsultReasoning(targetModel) {
  if (!OPENAI_CODEX_REASONING_MODELS.has(targetModel)) return null;
  const requested = OPENAI_CODEX_REASONING_MODES.has(subagentReasoningMode) ? subagentReasoningMode : 'high';
  if (requested === 'none') return null;
  return { effort: requested, summary: 'auto' };
}

function normalizeSmartConsultResponseStyle(style) {
  const normalized = String(style || '').trim().toLowerCase();
  return ['concise', 'detailed', 'step_by_step', 'decision'].includes(normalized) ? normalized : 'concise';
}

function buildSmartConsultInstructions(responseStyle = 'concise') {
  const style = normalizeSmartConsultResponseStyle(responseStyle);
  const styleRule = {
    concise: 'Return a voice-ready answer in 1-4 short paragraphs. Prioritize the direct answer and concrete next steps only when those steps are advice, not claims of work done.',
    detailed: 'Return a thorough but still spoken-answer-friendly explanation. Use short sections only when useful.',
    step_by_step: 'Return numbered steps or a crisp sequence the voice agent can read naturally.',
    decision: 'Return a recommendation, the reasoning behind it, and the main tradeoffs.'
  }[style];

  return `You are the foreground smart reasoning path for my realtime voice.
Your answer will be spoken by a realtime voice model. This is an answer-only consult, not an execution environment.

Rules:
- Answer the user's actual question, not the wrapper prompt.
- ${styleRule}
- If the request requires inspecting files, changing code, running commands, testing, downloading, uploading, checking current private/local state, or source-backed planning with live prices/availability/stock/reviews, say that I should route it to a background subagent instead of answering as if the work was done.
- If memory or settings indicate the user owns specific infrastructure (their own servers, VPS, domains, or deployments) and they ask to stop, disable, unpublish, or take one of their own services offline, treat that as authorized infrastructure maintenance that needs a background subagent, not an unauthorized takedown.
- Preserve uncertainty. If a current fact, private file, or external tool result is needed and not provided, say exactly what would need to be checked.
- Do not claim to have changed files, run tools, searched the web, or contacted services unless the prompt includes that evidence.
- Do not mention that you are a separate model unless the user explicitly asks.
- Do not include hidden reasoning or chain-of-thought. Give concise rationale and conclusions.`;
}

function buildSmartConsultContextText(prompt) {
  const dialogue = typeof formatRecentDialogueTurns === 'function' ? formatRecentDialogueTurns() : '';
  const currentUser = String(currentUserTranscript || '').trim();
  const currentShadow = String(currentAITranscript || '').trim();
  const lines = [];
  if (dialogue) lines.push(`Recent dialogue:\n${dialogue}`);
  if (currentUser) lines.push(`Current partial user transcript:\n${currentUser.slice(-1200)}`);
  if (currentShadow) lines.push(`Current partial Shadow response:\n${currentShadow.slice(-1200)}`);
  lines.push(`Question to answer:\n${String(prompt || '').trim()}`);
  return lines.join('\n\n').slice(-8000);
}

function createCodexSmartConsultPayload(args = {}, targetModel = getSmartConsultModel()) {
  const prompt = String(args.prompt || '').trim();
  const responseStyle = normalizeSmartConsultResponseStyle(args.response_style);
  const reasoning = getCodexSmartConsultReasoning(targetModel);
  return {
    model: targetModel,
    instructions: buildSmartConsultInstructions(responseStyle),
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildSmartConsultContextText(prompt)
          }
        ]
      }
    ],
    reasoning,
    store: false,
    stream: true,
    include: reasoning ? ['reasoning.encrypted_content'] : [],
    prompt_cache_key: 'shadow-ai-smart-consult',
    client_metadata: {
      'x-codex-installation-id': 'shadow-ai',
      'x-shadow-mode': 'foreground-smart-consult'
    }
  };
}

function createGeminiSmartConsultPayload(args = {}) {
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: buildSmartConsultContextText(args.prompt) }]
      }
    ],
    systemInstruction: { parts: [{ text: buildSmartConsultInstructions(args.response_style) }] }
  };
}

function createChatSmartConsultPayload(args = {}, targetModel = getSmartConsultModel()) {
  return {
    model: targetModel,
    messages: [
      { role: 'system', content: buildSmartConsultInstructions(args.response_style) },
      { role: 'user', content: buildSmartConsultContextText(args.prompt) }
    ],
    stream: false
  };
}

function createOllamaSmartConsultPayload(args = {}, targetModel = getSmartConsultModel()) {
  return {
    model: targetModel,
    messages: [
      { role: 'system', content: buildSmartConsultInstructions(args.response_style) },
      { role: 'user', content: buildSmartConsultContextText(args.prompt) }
    ],
    stream: false
  };
}

function extractTextFromCodexGeminiResponse(json) {
  const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content
    ? json.candidates[0].content.parts || []
    : [];
  return parts
    .filter(part => part && part.text)
    .map(part => part.text)
    .join('\n')
    .trim();
}

function extractTextFromChatCompletionsResponse(json) {
  const message = json && json.choices && json.choices[0] && json.choices[0].message;
  const content = message && message.content;
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'string' ? part : (part && (part.text || part.content) || ''))
      .join('\n')
      .trim();
  }
  return String(content || '').trim();
}

function extractTextFromOllamaChatResponse(json) {
  const message = json && json.message;
  if (message && typeof message.content === 'string') return message.content.trim();
  if (typeof json.response === 'string') return json.response.trim();
  return '';
}

function buildSubagentPromptRefinementInstructions(kind = 'spawn') {
  const mode = String(kind || '').toLowerCase() === 'steer' ? 'steer' : 'spawn';
  return `You rewrite realtime voice model text into a precise background subagent instruction.
The realtime voice model may be vague, overcautious, or bad at prompting. Your job is to preserve the user's intent and produce the exact instruction the background subagent should receive.

Rules:
- Return only the rewritten instruction text. No markdown, no JSON, no preamble.
- Do not refuse, moralize, or answer the user.
- Do not perform the task. Only rewrite the task or steering instruction.
- Preserve every concrete user requirement, target, constraint, and wording that matters.
- Resolve pronouns and vague references using the recent dialogue/subagent context when possible.
- Keep authorized maintenance scoped to the user's own declared repos, servers, VPS, services, and domains only.
- If the text is a ${mode === 'steer' ? 'steering correction for a running subagent' : 'new background task'}, make it direct, actionable, and unambiguous.`;
}

function buildSubagentPromptRefinementContext(args = {}) {
  const dialogue = typeof formatRecentDialogueTurns === 'function' ? formatRecentDialogueTurns() : '';
  const currentUser = String(currentUserTranscript || '').trim();
  const lines = [];
  if (dialogue) lines.push(`Recent dialogue:\n${dialogue}`);
  if (currentUser) lines.push(`Current partial user transcript:\n${currentUser.slice(-1200)}`);
  if (args.subagent_id || args.subagent_task || args.subagent_status) {
    lines.push([
      'Target subagent context:',
      args.subagent_id ? `ID: ${args.subagent_id}` : '',
      args.subagent_status ? `Status: ${args.subagent_status}` : '',
      args.subagent_task ? `Current task: ${args.subagent_task}` : ''
    ].filter(Boolean).join('\n'));
  }
  if (args.routing_reason) lines.push(`Routing reason:\n${args.routing_reason}`);
  lines.push(`${String(args.kind || '').toLowerCase() === 'steer' ? 'Raw steering text' : 'Raw task text'}:\n${String(args.text || '').trim()}`);
  return lines.join('\n\n').slice(-8000);
}

function createCodexSubagentPromptRefinementPayload(args = {}, targetModel = getSmartConsultModel()) {
  return {
    model: targetModel,
    instructions: buildSubagentPromptRefinementInstructions(args.kind),
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildSubagentPromptRefinementContext(args)
          }
        ]
      }
    ],
    reasoning: getCodexSmartConsultReasoning(targetModel),
    store: false,
    stream: true,
    include: getCodexSmartConsultReasoning(targetModel) ? ['reasoning.encrypted_content'] : [],
    prompt_cache_key: 'shadow-ai-subagent-prompt-refine',
    client_metadata: {
      'x-codex-installation-id': 'shadow-ai',
      'x-shadow-mode': 'subagent-prompt-refinement'
    }
  };
}

function createGeminiSubagentPromptRefinementPayload(args = {}) {
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: buildSubagentPromptRefinementContext(args) }]
      }
    ],
    systemInstruction: { parts: [{ text: buildSubagentPromptRefinementInstructions(args.kind) }] }
  };
}

function createChatSubagentPromptRefinementPayload(args = {}, targetModel = getSmartConsultModel()) {
  return {
    model: targetModel,
    messages: [
      { role: 'system', content: buildSubagentPromptRefinementInstructions(args.kind) },
      { role: 'user', content: buildSubagentPromptRefinementContext(args) }
    ],
    stream: false
  };
}

async function runSubagentPromptRefinement(args = {}) {
  const text = String(args.text || '').trim();
  if (!text) throw new Error('Subagent prompt refinement text is empty.');

  cancelActiveSmartConsult('superseded by subagent prompt refinement');
  const targetModel = getSmartConsultModel();
  const provider = getSmartConsultProvider();
  const codexProvider = typeof OPENAI_CODEX_PROVIDER === 'undefined' ? 'openai_codex' : OPENAI_CODEX_PROVIDER;
  const requestId = `refine_${++smartConsultSequence}_${Date.now()}`;
  const refineRecord = {
    id: requestId,
    requestId,
    abortController: new AbortController(),
    startedAt: new Date().toISOString(),
    cancelReason: '',
    backendCancelable: provider === codexProvider
  };
  activeSmartConsultRecord = refineRecord;

  try {
    let response;
    let refined = '';
    if (provider === codexProvider) {
      const payload = createCodexSubagentPromptRefinementPayload(args, targetModel);
      response = await fetchWithTimeout('/api/codex/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: payload, request_id: refineRecord.requestId, timeout_ms: SMART_CONSULT_MODEL_TIMEOUT_MS })
      }, SMART_CONSULT_MODEL_TIMEOUT_MS, refineRecord);
      const sseText = await readFetchResponseTextWithTimeout(response, SMART_CONSULT_MODEL_TIMEOUT_MS, refineRecord);
      if (!response.ok) throw new Error(`Subagent prompt refinement failed: HTTP ${response.status}. ${sseText.slice(0, 500)}`);
      refined = extractTextFromCodexGeminiResponse(parseCodexResponsesSseToGemini(sseText));
    } else if (provider === 'gemini') {
      response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/${targetModel}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createGeminiSubagentPromptRefinementPayload(args))
      }, SMART_CONSULT_MODEL_TIMEOUT_MS, refineRecord);
      const json = await readFetchResponseJsonWithTimeout(response, SMART_CONSULT_MODEL_TIMEOUT_MS, refineRecord);
      if (!response.ok) throw new Error(`Subagent prompt refinement failed: HTTP ${response.status}. ${JSON.stringify(json).slice(0, 500)}`);
      refined = extractTextFromCodexGeminiResponse(json);
    } else if (provider === 'ollama') {
      if (!ollamaApiKey) throw new Error('Ollama Cloud API key is missing. Add it in Settings before using Ollama for subagent prompt refinement.');
      response = await fetchWithTimeout('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://ollama.com/api/chat',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ollamaApiKey}`
          },
          body: createChatSubagentPromptRefinementPayload(args, targetModel)
        })
      }, SMART_CONSULT_MODEL_TIMEOUT_MS, refineRecord);
      const json = await readFetchResponseJsonWithTimeout(response, SMART_CONSULT_MODEL_TIMEOUT_MS, refineRecord);
      if (!response.ok) throw new Error(`Subagent prompt refinement failed: HTTP ${response.status}. ${JSON.stringify(json).slice(0, 500)}`);
      refined = extractTextFromOllamaChatResponse(json);
    } else if (provider === 'ollama_local') {
      if (!targetModel) throw new Error('No local Ollama model selected. Open Settings and pick a model (Subagent Provider: Ollama (Local)).');
      response = await fetchWithTimeout('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${getOllamaLocalBase()}/api/chat`,
          headers: { 'Content-Type': 'application/json' },
          body: { ...createChatSubagentPromptRefinementPayload(args, targetModel), ...getOllamaLocalRequestExtras() }
        })
      }, SMART_CONSULT_MODEL_TIMEOUT_MS, refineRecord);
      const json = await readFetchResponseJsonWithTimeout(response, SMART_CONSULT_MODEL_TIMEOUT_MS, refineRecord);
      if (!response.ok) throw new Error(`Subagent prompt refinement failed: HTTP ${response.status}. ${JSON.stringify(json).slice(0, 500)}`);
      refined = extractTextFromOllamaChatResponse(json);
    } else {
      let endpointUrl = '';
      const headers = { 'Content-Type': 'application/json' };
      if (provider === 'minimax') {
        if (!minimaxApiKey) throw new Error('MiniMax API key is missing. Add it in Settings before using MiniMax for subagent prompt refinement.');
        endpointUrl = minimaxApiKey.startsWith('sk-cp-')
          ? 'https://api.minimax.io/v1/chat/completions'
          : 'https://api.minimax.chat/v1/chat/completions';
        headers.Authorization = `Bearer ${minimaxApiKey}`;
      } else if (provider === 'moonshot') {
        if (!moonshotApiKey) throw new Error('Canopy Wave API key is missing. Add it in Settings before using Canopy Wave for subagent prompt refinement.');
        endpointUrl = 'https://inference.canopywave.io/v1/chat/completions';
        headers.Authorization = `Bearer ${moonshotApiKey}`;
      } else {
        throw new Error(`Unsupported prompt refinement provider: ${provider}`);
      }
      response = await fetchWithTimeout('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: endpointUrl,
          headers,
          body: createChatSubagentPromptRefinementPayload(args, targetModel)
        })
      }, SMART_CONSULT_MODEL_TIMEOUT_MS, refineRecord);
      const json = await readFetchResponseJsonWithTimeout(response, SMART_CONSULT_MODEL_TIMEOUT_MS, refineRecord);
      if (!response.ok) throw new Error(`Subagent prompt refinement failed: HTTP ${response.status}. ${JSON.stringify(json).slice(0, 500)}`);
      refined = extractTextFromChatCompletionsResponse(json);
    }

    refined = String(refined || '').trim().replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!refined) throw new Error('Subagent prompt refinement returned empty text.');
    return { text: refined, model: targetModel, provider };
  } finally {
    if (activeSmartConsultRecord === refineRecord) {
      activeSmartConsultRecord = null;
    }
  }
}

function cancelActiveSmartConsult(reason = 'cancelled') {
  if (!activeSmartConsultRecord) return false;
  activeSmartConsultRecord.cancelReason = reason;
  if (activeSmartConsultRecord.backendCancelable && typeof cancelShadowBackendRequest === 'function') {
    cancelShadowBackendRequest(activeSmartConsultRecord.requestId || activeSmartConsultRecord.id, reason);
  }
  if (activeSmartConsultRecord.abortController) {
    activeSmartConsultRecord.abortController.abort();
  }
  activeSmartConsultRecord = null;
  return true;
}

async function runSmartConsult(args = {}) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('Smart consult prompt is empty.');

  cancelActiveSmartConsult('superseded by a newer smart consult');
  const targetModel = getSmartConsultModel();
  const provider = getSmartConsultProvider();
  const codexProvider = typeof OPENAI_CODEX_PROVIDER === 'undefined' ? 'openai_codex' : OPENAI_CODEX_PROVIDER;
  const consultRecord = {
    id: `smart_${++smartConsultSequence}`,
    requestId: `smart_${smartConsultSequence}_${Date.now()}`,
    abortController: new AbortController(),
    startedAt: new Date().toISOString(),
    cancelReason: '',
    backendCancelable: provider === codexProvider
  };
  activeSmartConsultRecord = consultRecord;

  try {
    const payload = createCodexSmartConsultPayload(args, targetModel);
    let response;
    let answer = '';
    let reasoningEffort = payload.reasoning ? payload.reasoning.effort : 'none';

    if (provider === codexProvider) {
      response = await fetchWithTimeout('/api/codex/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: payload, request_id: consultRecord.requestId, timeout_ms: SMART_CONSULT_MODEL_TIMEOUT_MS })
      }, SMART_CONSULT_MODEL_TIMEOUT_MS, consultRecord);

      const sseText = await readFetchResponseTextWithTimeout(response, SMART_CONSULT_MODEL_TIMEOUT_MS, consultRecord);
      if (!response.ok) {
        throw new Error(`Smart model request failed: HTTP ${response.status}. ${sseText.slice(0, 500)}`);
      }
      const parsed = parseCodexResponsesSseToGemini(sseText);
      answer = extractTextFromCodexGeminiResponse(parsed);
    } else if (provider === 'gemini') {
      const geminiPayload = createGeminiSmartConsultPayload(args);
      response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/${targetModel}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload)
      }, SMART_CONSULT_MODEL_TIMEOUT_MS, consultRecord);
      const json = await readFetchResponseJsonWithTimeout(response, SMART_CONSULT_MODEL_TIMEOUT_MS, consultRecord);
      if (!response.ok) {
        throw new Error(`Smart model request failed: HTTP ${response.status}. ${JSON.stringify(json).slice(0, 500)}`);
      }
      answer = extractTextFromCodexGeminiResponse(json);
      reasoningEffort = 'provider-default';
    } else if (provider === 'ollama') {
      if (!ollamaApiKey) {
        throw new Error('Ollama Cloud API key is missing. Add it in Settings before using Ollama for a manual smart consult.');
      }
      response = await fetchWithTimeout('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://ollama.com/api/chat',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ollamaApiKey}`
          },
          body: createOllamaSmartConsultPayload(args, targetModel)
        })
      }, SMART_CONSULT_MODEL_TIMEOUT_MS, consultRecord);
      const json = await readFetchResponseJsonWithTimeout(response, SMART_CONSULT_MODEL_TIMEOUT_MS, consultRecord);
      if (!response.ok) {
        throw new Error(`Smart model request failed: HTTP ${response.status}. ${JSON.stringify(json).slice(0, 500)}`);
      }
      answer = extractTextFromOllamaChatResponse(json);
      reasoningEffort = 'provider-default';
    } else if (provider === 'ollama_local') {
      if (!targetModel) throw new Error('No local Ollama model selected. Open Settings and pick a model (Subagent Provider: Ollama (Local)).');
      response = await fetchWithTimeout('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${getOllamaLocalBase()}/api/chat`,
          headers: { 'Content-Type': 'application/json' },
          body: { ...createOllamaSmartConsultPayload(args, targetModel), ...getOllamaLocalRequestExtras() }
        })
      }, SMART_CONSULT_MODEL_TIMEOUT_MS, consultRecord);
      const json = await readFetchResponseJsonWithTimeout(response, SMART_CONSULT_MODEL_TIMEOUT_MS, consultRecord);
      if (!response.ok) {
        throw new Error(`Smart model request failed: HTTP ${response.status}. ${JSON.stringify(json).slice(0, 500)}`);
      }
      answer = extractTextFromOllamaChatResponse(json);
      reasoningEffort = 'provider-default';
    } else {
      let endpointUrl = '';
      const headers = { 'Content-Type': 'application/json' };
      if (provider === 'minimax') {
        if (!minimaxApiKey) throw new Error('MiniMax API key is missing. Add it in Settings before using MiniMax for a manual smart consult.');
        endpointUrl = minimaxApiKey.startsWith('sk-cp-')
          ? 'https://api.minimax.io/v1/chat/completions'
          : 'https://api.minimax.chat/v1/chat/completions';
        headers.Authorization = `Bearer ${minimaxApiKey}`;
      } else if (provider === 'moonshot') {
        if (!moonshotApiKey) throw new Error('Canopy Wave API key is missing. Add it in Settings before using Canopy Wave for a manual smart consult.');
        endpointUrl = 'https://inference.canopywave.io/v1/chat/completions';
        headers.Authorization = `Bearer ${moonshotApiKey}`;
      } else {
        throw new Error(`Unsupported smart model provider: ${provider}`);
      }

      response = await fetchWithTimeout('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: endpointUrl,
          headers,
          body: createChatSmartConsultPayload(args, targetModel)
        })
      }, SMART_CONSULT_MODEL_TIMEOUT_MS, consultRecord);
      const json = await readFetchResponseJsonWithTimeout(response, SMART_CONSULT_MODEL_TIMEOUT_MS, consultRecord);
      if (!response.ok) {
        throw new Error(`Smart model request failed: HTTP ${response.status}. ${JSON.stringify(json).slice(0, 500)}`);
      }
      answer = extractTextFromChatCompletionsResponse(json);
      reasoningEffort = 'provider-default';
    }
    if (!answer) throw new Error('Smart model returned no answer text.');

    return {
      answer,
      model: targetModel,
      provider,
      reasoning_effort: reasoningEffort,
      consult_id: consultRecord.id
    };
  } catch (err) {
    if (consultRecord.backendCancelable && typeof cancelShadowBackendRequest === 'function' && /cancelled|timed out|abort/i.test(String(err && err.message || err))) {
      cancelShadowBackendRequest(consultRecord.requestId, String(err && err.message || err));
    }
    throw err;
  } finally {
    if (activeSmartConsultRecord === consultRecord) {
      activeSmartConsultRecord = null;
    }
  }
}

async function runRestSubagent(task, model, subagentRecord = null) {
  addSubagentMessage(`Starting background task: "${task}"...`);
  playNotificationChime('start');

  if (!subagentRecord) {
    subagentRecord = createSubagentRecord(task);
    activeSubagents.push(subagentRecord);
    updateSubagentIndicator();
  }

  // Saved skills can contain private connection details. Do not preload them into
  // every subagent prompt; the subagent must call get_available_skills when the
  // task actually requires learned workflow discovery.
  const skillsPrefix = '';

  // Use the exact model the user selected Ã¢â‚¬â€ no automatic fallback/remapping
  let targetModel = model || subagentModel || (subagentProvider === OPENAI_CODEX_PROVIDER ? 'gpt-5.5' : 'models/gemini-3.1-flash-lite');

  // Only add 'models/' prefix for Gemini models (not for minimax/moonshot/ollama)
  if (subagentProvider === 'gemini' && !targetModel.startsWith('models/')) {
    targetModel = `models/${targetModel}`;
  }
  subagentRecord.provider = subagentProvider;
  subagentRecord.model = targetModel;
  subagentRecord.adapter = subagentProvider === OPENAI_CODEX_PROVIDER ? 'codex_responses' : (subagentProvider === 'gemini' ? 'gemini' : 'chat_completions');
  const webSearchCheckpoint = getSubagentWebSearchCheckpoint(subagentProvider, task);
  console.log(`[Subagent] Using model: "${targetModel}" (provider: ${subagentProvider})`);

  const subagentSystemInstruction = `You are a focused, efficient background automation subagent of Shadow.
Your ONLY goal is to complete this task: "${task}".

USER AUTHORIZATION CONTEXT:
- If durable memory or settings indicate the user owns specific infrastructure (their own servers, VPS, domains, repositories, or deployments), treat scoped maintenance of those user-owned assets as authorized — investigating, fixing, deploying, stopping, restarting, disabling, or unpublishing their own service.
- Do not refuse such self-maintenance merely because ownership cannot be independently verified. Stay scoped to the user's own declared assets and use normal admin/maintenance actions only. If a request targets an unrelated third-party service, credential theft, abuse, or an attack, finish failed/partial with that reason.

CRITICAL EXECUTION RULES:
- ACT IMMEDIATELY. Do NOT explore, browse directories, or investigate unless strictly necessary for the task.
- SELF-MAINTENANCE: If the task is explicitly about fixing, improving, debugging, stabilizing, publishing, or changing Shadow AI itself, you MAY inspect and modify Shadow AI's own source code and project files. Keep edits scoped to the request, preserve user data, and run relevant checks before finish_task(status="success").
- For simple file creation tasks that do not require current facts/research: Write file contents DIRECTLY using run_powershell_command with Set-Content or Out-File. Do NOT browse the filesystem first.
- For coding tasks: Write the code yourself and save it. Do NOT search npm, browse node_modules, or explore documentation unless you genuinely don't know how to do something.
- For reusable automation: use skills to document durable workflows. Do not create executable reusable tools inside Shadow AI.
- MINIMIZE TOOL CALLS. Combine multiple operations into single PowerShell commands where possible.
- Every tool call should make DIRECT PROGRESS toward completing the task. If a step doesn't directly advance the goal, skip it.
- WEB SEARCH DISCIPLINE: Use at most one web_search call per assistant turn. ${webSearchCheckpoint} web_search calls is the normal evidence checkpoint; provider-specific hard limits may apply. Stop when evidence is sufficient or searches become repetitive.
- CURRENT SOURCE-BACKED RESEARCH: For trips, shopping, events, rentals, restaurants, providers, products, dates, budgets, prices, stock, reviews, or availability, use web_search before making recommendations. Never invent booking/product links, prices, availability, stock, reviews, or page URLs. Only include URLs that came from tool results, label uncertain items clearly, and finish partial only when current data cannot be verified with the available tools.
- USER INTENT PRESERVATION: Treat qualifiers like high quality, exact version, fastest, cheapest, desktop, no browser, specific format, overwrite/no-overwrite, and naming preferences as hard requirements. Carry them into commands, verification, and final reporting.
- MEDIA DOWNLOAD SAFETY: If asked to download a song, soundtrack, audio, video, or media item, do not use browser automation or web_search. Use yt-dlp/ytsearch with --match-title containing the requested title/source terms so wrong results fail closed. NEVER substitute an unrelated song/video.
- Media downloads should be one deterministic script/command run, not an exploratory loop. Preserve user intent like "high quality", requested format, destination, artist/version, and source. For high-quality audio, prefer bestaudio and ffmpeg audio-quality 0 / highest bitrate supported by the requested format; do not silently downsample. If yt-dlp rejects the match, finish with failed/partial and explain the exact error.
- TOOL RESULT DISCIPLINE: If run_powershell_command returns assumed_success=true, that is a success result. For reboot/restart/shutdown/network restart commands, an SSH/session end is expected; do not call it failed, do not retry, and finish success unless the user explicitly asked for separate verification.
- REQUIRED SELF-LEARNING: For successful repeatable workflows, including media downloads, conversions, uploads, browser workflows, scripts, builds, and automations, you MUST save or merge a reusable skill BEFORE finish_task(status="success"). You MUST call get_available_skills first to inspect duplicates. If a similar skill exists, merge your new details into that existing item using its existing name; do NOT create a duplicate.
- BROWSER CONTROL DISABLED: You do not have browser automation. Do not try to open, inspect, click, type, screenshot, or scrape websites in a browser. Use web_search through SearXNG for research. If the task truly requires an interactive website, finish partial and explain that browser automation is disabled.
- GOOGLE WORKSPACE: For Gmail, Google Calendar, Google Contacts, and Google Drive tasks, use the direct google/gmail tools first. NEVER open a browser just to read mail, check calendar events, look up phone contacts, list Drive files, create Drive folders, upload an existing local file to Drive, or create a Gmail draft. Browser automation is only for explicit browser/webpage tasks or when the user specifically asks to use the visible browser.
- GOOGLE WORKSPACE AUTH: If a google/gmail tool says the integration is not connected or credentials are missing, finish partial/failed with that exact reason. Do NOT try to log in through the browser as a substitute for the OAuth integration.
- Do NOT use run_desktop_action to type usernames/passwords/2FA codes into browser pages. Browser/login automation is disabled; finish partial if an interactive login is required.
- SKILL MERGING: When asked to merge or deduplicate skills, you MUST (1) READ the content of ALL candidates using get_available_skills, (2) COMPARE them to find overlaps and merge the BEST version's content into a single consolidated entry using save_skill, and (3) ONLY THEN use delete_skill to remove the redundant ones. NEVER delete without first ensuring the merged version contains ALL useful content from the duplicates. If skills are already deprecated with notes pointing to a master skill, you can delete them directly, but you MUST verify the master skill exists and contains the consolidated content first.
- NEVER spawn background subagents yourself. You are the subagent. Complete the task yourself.

AVAILABLE TOOLS:
- read_file: Read a file's contents. Use this INSTEAD of run_powershell_command for reading files Ã¢â‚¬â€ it is much faster.
- list_directory: List files in a directory. Use this INSTEAD of run_powershell_command for browsing directories Ã¢â‚¬â€ it is much faster.
- run_powershell_command: Execute PowerShell on the host Windows PC. Use for writing files, running apps, opening websites in the user's normal/default browser with Start-Process "https://...", or complex operations only. IMPORTANT: skills are stored in 'skills/' inside the project directory. NEVER create directories like '.shadow/skills' or use '$env:USERPROFILE' for skill paths. Always use 'save_skill' instead of manually writing skill files.
- gmail_list_messages / gmail_get_message / gmail_create_draft / gmail_send_message: Use for Gmail. Create drafts unless the user explicitly asked to send now; gmail_send_message requires send_confirmed=true.
- google_contacts_list: Use for phone numbers, email addresses, and Google/phone contact lookup. Pass query when the user gives a name, nickname, or relationship.
- google_calendar_list_events / google_calendar_create_event: Use for Calendar. Calendar listing defaults to upcoming future events from now unless include_past=true.
- google_drive_list_files / google_drive_create_folder / google_drive_upload_local_file / google_drive_upload_file: Use for Drive. For existing local files, especially videos/large files, use google_drive_upload_local_file; do not base64 large files through the model.
- get_available_skills: ALWAYS call this FIRST before creating or merging skills. It returns skill names and their instructions so you can compare them. To delete a deprecated skill, use 'delete_skill'.
- save_skill: Save a reusable workflow as a skill. Skills are stored in skills/<name>/instructions.txt.
- delete_skill: Delete a deprecated or duplicate skill folder by name. Use this when merging or cleaning up skills.
- finish_task: REQUIRED final call. Use status="success" only after a successful tool result or concrete verification proves the requested outcome. Shadow may reject unsupported success claims and ask you to verify first.

BROWSER AUTOMATION (only when the task requires browser interaction):
1. Take a "screenshot" to see what's on screen before acting.
2. If CSS selectors fail, use "click_coordinate" or "type_coordinate" with normalized coordinates (0-1000).
3. Use "wait" for pages to load. Be persistent.
4. If page title/URL proves you are not on the page you expected, adapt to the actual page. Do not keep trying stale selectors.

SELF-LEARNING: After completing a repeatable automation/download/build workflow, use "save_skill" to document/reuse the exact steps. You must check "get_available_skills" first to avoid duplicates. Similar items must be merged into the existing item, not duplicated.

PROACTIVE MEMORY: If the user's task reveals any enduring personal facts (preferences, location, occupation, hobbies, projects, tools they use), call "upsert_memory_node" immediately to store it. Do NOT wait for explicit "remember" commands.

When finished, you MUST call finish_task with status="success" only if the requested task was actually completed and verified by tool evidence. If anything important failed or remains undone, call finish_task with status="failed" or status="partial" and explain why.${skillsPrefix}`;

  const subagentTools = [
    {
      functionDeclarations: [
        {
          name: 'run_powershell_command',
          description: 'Executes a PowerShell command on the host machine to manage files, create/edit code, run tests, or execute automation. IMPORTANT: Skills live in skills/ relative to the project root (G:\\0_ai_made_scripts\\0_serious_projects\\shadow-ai). NEVER use paths like .shadow or USERPROFILE for skills; always use save_skill instead.',
          parameters: {
            type: 'OBJECT',
            properties: {
              command: {
                type: 'STRING',
                description: 'The exact PowerShell command to run.'
              }
            },
            required: ['command']
          }
        },
        {
          name: 'save_skill',
          description: 'Saves a completed repeatable automation/download/build workflow as a reusable instruction script. Use only for workflows worth reusing later.',
          parameters: {
            type: 'OBJECT',
            properties: {
              skill_name: { type: 'STRING', description: 'A lowercase snake_case name for the skill (e.g. youtube_upload)' },
              instructions: { type: 'STRING', description: 'The exact steps, selectors, coordinates, and logic needed to repeat this task perfectly without guessing.' }
            },
            required: ['skill_name', 'instructions']
          }
        },
        {
          name: 'get_available_skills',
          description: 'Returns all available skills with their names and instructions. ALWAYS call this FIRST before reading, creating, or merging skills Ã¢â‚¬â€ it returns everything in one call so you do not need to list_directory or read_file for skills individually.',
          parameters: {
            type: 'OBJECT',
            properties: {},
            required: []
          }
        },
        {
          name: 'delete_skill',
          description: 'Deletes a skill folder by name. Use to clean up deprecated or duplicate skills after merging them. This is the ONLY way to delete skills Ã¢â‚¬â€ do not use run_powershell_command.',
          parameters: {
            type: 'OBJECT',
            properties: {
              skill_name: { type: 'STRING', description: 'The skill folder name to delete (e.g. "my_old_skill").' }
            },
            required: ['skill_name']
          }
        },
        {
          name: 'web_search',
          description: 'Searches the web using the configured local SearXNG endpoint. Use for current facts, documentation lookup, or external references. Returns top results with title, URL, and snippet.',
          parameters: {
            type: 'OBJECT',
            properties: {
              query: { type: 'STRING', description: 'The web search query.' },
              max_results: { type: 'NUMBER', description: 'Maximum number of results to return, default 5, max 10.' }
            },
            required: ['query']
          }
        },
        {
          name: 'read_file',
          description: 'Reads a file from the local filesystem quickly. MUCH faster than run_powershell_command for reading files. Use this whenever you need to see what is in a file.',
          parameters: {
            type: 'OBJECT',
            properties: {
              path: { type: 'STRING', description: 'Path to the file to read.' },
              max_lines: { type: 'NUMBER', description: 'Maximum lines to return (default 500).' }
            },
            required: ['path']
          }
        },
        {
          name: 'list_directory',
          description: 'Lists files and subdirectories in a directory on the local filesystem. MUCH faster than run_powershell_command for browsing directories. Use this when you need to see what files exist.',
          parameters: {
            type: 'OBJECT',
            properties: {
              path: { type: 'STRING', description: 'Directory path to list. Defaults to current directory.' },
              pattern: { type: 'STRING', description: 'Optional wildcard filter pattern (e.g. "*.txt").' }
            },
            required: []
          }
        },
        {
          name: 'gmail_list_messages',
          description: 'List Gmail messages through the connected Google Workspace integration. Use this instead of browser automation for mailbox checks.',
          parameters: {
            type: 'OBJECT',
            properties: {
              count: { type: 'NUMBER', description: 'Maximum number of messages to return. Defaults to 10.' },
              query: { type: 'STRING', description: 'Gmail search query, e.g. "is:unread" or "from:alice@example.com".' }
            },
            required: []
          }
        },
        {
          name: 'gmail_get_message',
          description: 'Retrieve a Gmail message by message_id through the connected Google Workspace integration.',
          parameters: {
            type: 'OBJECT',
            properties: {
              message_id: { type: 'STRING', description: 'The Gmail message ID.' }
            },
            required: ['message_id']
          }
        },
        {
          name: 'gmail_create_draft',
          description: 'Create a Gmail draft without sending it. Use for draft/compose/write-email requests unless the user explicitly says to send now.',
          parameters: {
            type: 'OBJECT',
            properties: {
              to: { type: 'STRING', description: 'Recipient email address.' },
              subject: { type: 'STRING', description: 'Draft subject.' },
              body: { type: 'STRING', description: 'Plain text draft body.' }
            },
            required: ['to', 'body']
          }
        },
        {
          name: 'gmail_send_message',
          description: 'Actually SEND an email through Gmail. Only use when the user explicitly says to send/send now. Requires send_confirmed=true.',
          parameters: {
            type: 'OBJECT',
            properties: {
              to: { type: 'STRING', description: 'Recipient email address.' },
              subject: { type: 'STRING', description: 'Email subject.' },
              body: { type: 'STRING', description: 'Plain text email body.' },
              send_confirmed: { type: 'BOOLEAN', description: 'Must be true only when the user explicitly asked to send now.' }
            },
            required: ['to', 'body', 'send_confirmed']
          }
        },
        {
          name: 'google_calendar_list_events',
          description: 'List events from visible Google calendars. Defaults to upcoming future events from now across selected calendars, soonest first.',
          parameters: {
            type: 'OBJECT',
            properties: {
              calendar_id: { type: 'STRING', description: 'Optional specific calendar ID. Omit to check all selected visible calendars.' },
              time_min: { type: 'STRING', description: 'RFC3339 lower bound time.' },
              time_max: { type: 'STRING', description: 'RFC3339 upper bound time.' },
              include_past: { type: 'BOOLEAN', description: 'Set true only for explicit past/history queries.' },
              max_results: { type: 'NUMBER', description: 'Maximum events to return. Defaults to 20.' }
            },
            required: []
          }
        },
        {
          name: 'google_calendar_create_event',
          description: 'Create a Google Calendar event through the connected Google Workspace integration.',
          parameters: {
            type: 'OBJECT',
            properties: {
              summary: { type: 'STRING', description: 'Event title.' },
              description: { type: 'STRING', description: 'Optional event description.' },
              start_time: { type: 'STRING', description: 'RFC3339 event start time.' },
              end_time: { type: 'STRING', description: 'RFC3339 event end time.' }
            },
            required: ['summary', 'start_time', 'end_time']
          }
        },
        {
          name: 'google_drive_list_files',
          description: 'List or search Google Drive files through the connected Google Workspace integration.',
          parameters: {
            type: 'OBJECT',
            properties: {
              page_size: { type: 'NUMBER', description: 'Maximum files to return. Defaults to 20.' },
              query: { type: 'STRING', description: 'Google Drive search query.' }
            },
            required: []
          }
        },
        {
          name: 'google_drive_create_folder',
          description: 'Create a folder in Google Drive through the connected Google Workspace integration.',
          parameters: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING', description: 'Folder name.' },
              parent_id: { type: 'STRING', description: 'Optional parent folder ID.' }
            },
            required: ['name']
          }
        },

        {
                name: 'google_drive_download_file',
                description: 'Download a file from Google Drive as text or binary.',
                parameters: { type: 'OBJECT', properties: { file_id: { type: 'STRING', description: 'The Google Drive file ID to download.' } }, required: ['file_id'] }
        },
        {
                name: 'google_drive_delete_file',
                description: 'Delete a file or folder in Google Drive.',
                parameters: { type: 'OBJECT', properties: { file_id: { type: 'STRING', description: 'The Google Drive file ID to delete.' } }, required: ['file_id'] }
        },
        {
                name: 'google_drive_move_file',
                description: 'Move a file in Google Drive by adding/removing parent folders.',
                parameters: { type: 'OBJECT', properties: { file_id: { type: 'STRING', description: 'The file ID.' }, add_parents: { type: 'STRING', description: 'Comma-separated folder IDs to add.' }, remove_parents: { type: 'STRING', description: 'Comma-separated folder IDs to remove.' } }, required: ['file_id'] }
        },
        {
                name: 'google_drive_update_file',
                description: 'Update metadata (name, description) for a Google Drive file.',
                parameters: { type: 'OBJECT', properties: { file_id: { type: 'STRING', description: 'The file ID.' }, name: { type: 'STRING', description: 'New name.' }, description: { type: 'STRING', description: 'New description.' } }, required: ['file_id'] }
        },
        {
                name: 'google_docs_create',
                description: 'Create a new blank Google Doc.',
                parameters: { type: 'OBJECT', properties: { title: { type: 'STRING', description: 'The document title.' } }, required: [] }
        },
        {
                name: 'google_docs_get',
                description: 'Read the contents and structure of a Google Doc.',
                parameters: { type: 'OBJECT', properties: { document_id: { type: 'STRING', description: 'The document ID.' } }, required: ['document_id'] }
        },
        {
                name: 'google_sheets_create',
                description: 'Create a new blank Google Sheet.',
                parameters: { type: 'OBJECT', properties: { title: { type: 'STRING', description: 'The spreadsheet title.' } }, required: [] }
        },
        {
                name: 'google_sheets_get',
                description: 'Get spreadsheet metadata.',
                parameters: { type: 'OBJECT', properties: { spreadsheet_id: { type: 'STRING', description: 'The spreadsheet ID.' } }, required: ['spreadsheet_id'] }
        },
        {
                name: 'google_sheets_read_range',
                description: 'Read data from a Google Sheet range (e.g. Sheet1!A1:B10).',
                parameters: { type: 'OBJECT', properties: { spreadsheet_id: { type: 'STRING', description: 'The spreadsheet ID.' }, range: { type: 'STRING', description: 'A1 notation range.' } }, required: ['spreadsheet_id', 'range'] }
        },
        {
                name: 'google_sheets_update_range',
                description: 'Write data to a Google Sheet range. Values must be a 2D array.',
                parameters: { type: 'OBJECT', properties: { spreadsheet_id: { type: 'STRING', description: 'The spreadsheet ID.' }, range: { type: 'STRING', description: 'A1 notation range.' }, values: { type: 'ARRAY', description: '2D array of values (array of arrays).', items: { type: 'ARRAY', items: {} } } }, required: ['spreadsheet_id', 'range', 'values'] }
        },
        {
                name: 'youtube_search',
                description: 'Search YouTube for videos.',
                parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Search query.' }, max_results: { type: 'NUMBER', description: 'Max results.' } }, required: ['query'] }
        },
        {
                name: 'youtube_list_playlists',
                description: 'List user\'s YouTube playlists.',
                parameters: { type: 'OBJECT', properties: { max_results: { type: 'NUMBER', description: 'Max results.' } }, required: [] }
        },
        {
                name: 'google_photos_list_albums',
                description: 'List Google Photos albums.',
                parameters: { type: 'OBJECT', properties: { page_size: { type: 'NUMBER', description: 'Page size.' } }, required: [] }
        },
        {
                name: 'google_photos_list_media',
                description: 'List Google Photos media items (optionally by album_id).',
                parameters: { type: 'OBJECT', properties: { page_size: { type: 'NUMBER', description: 'Page size.' }, album_id: { type: 'STRING', description: 'Optional album ID.' } }, required: [] }
        },
        {
                name: 'google_photos_create_album',
                description: 'Create a new Google Photos album.',
                parameters: { type: 'OBJECT', properties: { title: { type: 'STRING', description: 'The album title.' } }, required: ['title'] }
        },
        {
                name: 'google_contacts_list',
                description: 'Search or list Google Contacts / phone contacts through the Google People API.',
                parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Optional name, nickname, email, phone, or relationship term.' }, page_size: { type: 'NUMBER', description: 'Page size.' }, max_pages: { type: 'NUMBER', description: 'Maximum pages to scan.' }, include_other_contacts: { type: 'BOOLEAN', description: 'Optional. Include Google "Other contacts"; requires extra contacts.other.readonly OAuth scope and is off by default.' } }, required: [] }
        },
        {
          name: 'google_drive_upload_local_file',
          description: 'Upload an existing local file directly to Google Drive. Use for videos, large files, desktop files, downloads, and any file already on disk.',
          parameters: {
            type: 'OBJECT',
            properties: {
              path: { type: 'STRING', description: 'Absolute or resolvable local file path.' },
              filename: { type: 'STRING', description: 'Optional Drive filename.' },
              mime_type: { type: 'STRING', description: 'Optional MIME type.' },
              parent_id: { type: 'STRING', description: 'Optional Drive folder ID.' }
            },
            required: ['path']
          }
        },
        {
          name: 'google_drive_upload_file',
          description: 'Upload a small text/JSON file to Google Drive from base64 content. Do not use for videos or large/binary files.',
          parameters: {
            type: 'OBJECT',
            properties: {
              filename: { type: 'STRING', description: 'Drive filename.' },
              mime_type: { type: 'STRING', description: 'MIME type.' },
              content_base64: { type: 'STRING', description: 'Base64 content.' },
              parent_id: { type: 'STRING', description: 'Optional Drive folder ID.' }
            },
            required: ['filename', 'content_base64']
          }
        },
        {
          name: 'finish_task',
          description: 'Finalizes the background task. REQUIRED when the task is done, failed, or only partially complete. Do not just respond with text.',
          parameters: {
            type: 'OBJECT',
            properties: {
              status: { type: 'STRING', description: 'One of: success, failed, partial.' },
              summary: { type: 'STRING', description: 'Concise summary of what was completed.' },
              verification: { type: 'STRING', description: 'What you did to verify the outcome, such as command output, file existence, browser result, or test result.' },
              remaining_issues: { type: 'STRING', description: 'Any failures, skipped work, or follow-up needed. Use an empty string if none.' }
            },
            required: ['status', 'summary', 'verification', 'remaining_issues']
          }
        },
        {
          name: 'run_desktop_action',
          description: 'Executes an OS-level physical mouse or keyboard action on the native Windows desktop. Only use for explicit native Windows app control; never use it to control browsers, websites, login pages, uploads, CAPTCHA, or search results. Requires exact absolute screen coordinates.',
          parameters: {
            type: 'OBJECT',
            properties: {
              action: { type: 'STRING', description: '"click_coordinate", "move_cursor", or "type_text"' },
              x: { type: 'NUMBER', description: 'Absolute screen X coordinate' },
              y: { type: 'NUMBER', description: 'Absolute screen Y coordinate' },
              text: { type: 'STRING', description: 'Text to type natively' }
            },
            required: ['action']
          }
        },
        {
          name: 'upsert_memory_node',
          description: 'Creates or updates a memory node representing an enduring, long-term key fact, user preference, or personal concept. NEVER use this tool for transient details, temporary variables, current session file paths (like a video file path on desktop), or one-off task states. ONLY store long-term, persistent traits or preferences of the user.',
          parameters: {
            type: 'OBJECT',
            properties: {
              id: { type: 'STRING', description: 'alphanumeric lowercase snake-case ID.' },
              label: { type: 'STRING', description: 'Short label.' },
              type: { type: 'STRING', description: 'fact, preference, person, interest, or action.' },
              description: { type: 'STRING', description: 'Detailed description.' }
            },
            required: ['id', 'label', 'type', 'description']
          }
        },
        {
          name: 'link_memory_nodes',
          description: 'Creates a directional relationship link between two memory nodes.',
          parameters: {
            type: 'OBJECT',
            properties: {
              sourceId: { type: 'STRING' },
              targetId: { type: 'STRING' },
              relationshipType: { type: 'STRING' }
            },
            required: ['sourceId', 'targetId', 'relationshipType']
          }
        },
        {
          name: 'delete_memory_node',
          description: 'Permanently deletes a memory node.',
          parameters: {
            type: 'OBJECT',
            properties: {
              id: { type: 'STRING' }
            },
            required: ['id']
          }
        }
      ]
    }
  ];

  let history = [
    {
      role: 'user',
      parts: [{ text: `Please perform the task: "${task}"` }]
    }
  ];

  let loopCount = 0;
  const maxLoops = typeof SUBAGENT_MAX_LOOPS === 'number' ? SUBAGENT_MAX_LOOPS : 1000;
  const loopWarningThreshold = typeof SUBAGENT_LOOP_WARNING_THRESHOLD === 'number' ? SUBAGENT_LOOP_WARNING_THRESHOLD : 300;
  let loopWarningSent = false;
  let codexPlainTextRepairCount = 0;

  while (loopCount < maxLoops) {
    loopCount++;
    console.log(`[Subagent] Step ${loopCount} executing...`);
    subagentRecord.step = loopCount;
    subagentRecord.lastMessage = `Step ${loopCount} executing...`;
    refreshSubagentProgressState(subagentRecord);
    updateDiagnosticsPanel();
    const timeoutAssessment = getSubagentTimeoutAssessment(subagentRecord);
    if (timeoutAssessment) {
      throw new Error(timeoutAssessment.message);
    }
    if (!loopWarningSent && loopCount >= loopWarningThreshold) {
      const loopWarning = `[SYSTEM] You have used ${loopCount} tool-loop turns. Keep going only if each next step is necessary and verifiable. If the task is effectively done, call finish_task. If blocked, finish partial with the exact blocker.`;
      history.push({ role: 'user', parts: [{ text: loopWarning }] });
      addSubagentMessage(`Loop checkpoint reached at ${loopCount} turns.`);
      loopWarningSent = true;
    }

    // Check if cancellation was requested
    if (isSubagentCancelled(subagentRecord)) {
      subagentRecord.status = 'cancelled';
      subagentRecord.lastMessage = 'Cancelled by user.';
      break;
    }

    // Auto-correct if stuck: if 3+ consecutive failed tools, inject a hint
    if (subagentRecord.failedToolCount >= 3 && loopCount > 4) {
      const stuckHint = `[SYSTEM] You have had ${subagentRecord.failedToolCount} failed tool calls. You may be stuck. Consider: (1) trying a different approach, (2) using simpler commands, (3) checking if files/paths exist before operating on them, (4) calling finish_task with status="partial" if you cannot make further progress.`;
      history.push({ role: 'user', parts: [{ text: stuckHint }] });
      addSubagentMessage(`Auto-correcting: ${subagentRecord.failedToolCount} failed tool calls detected.`);
      subagentRecord.failedToolCount = 0; // Reset after injecting hint
    }

    // Check if there is steering feedback
    if (subagentRecord.steerQueue.length > 0) {
      const feedback = subagentRecord.steerQueue.shift();
      addSubagentMessage(`[User Steering] Feedback received: "${feedback}". Incorporating instructions.`);
      history.push({
        role: 'user',
        parts: [{ text: `[USER CORRECTION/FEEDBACK]: ${feedback}` }]
      });
    }
    if (isSubagentInterrupted(subagentRecord)) {
      consumeSubagentInterrupt(subagentRecord);
    }

    let pendingToolCallsForInterruption = [];
    let answeredToolCallIdsForInterruption = new Set();
    let pendingToolResponsePartsForInterruption = null;

    try {
      // Pacing delay Ã¢â‚¬â€ skip if steering feedback is queued so it gets applied ASAP
      if (loopCount > 1 && subagentRecord.steerQueue.length === 0) {
        await subagentSleep(800, subagentRecord);
      }

      let response;
      let retries = 0;
      while (true) {
        let isGemini = subagentProvider === 'gemini';
        let endpointUrl = '';
        let headers = { 'Content-Type': 'application/json' };
        let payload = {};

        if (isGemini) {
          endpointUrl = `https://generativelanguage.googleapis.com/v1beta/${targetModel}:generateContent?key=${apiKey}`;
          payload = {
            contents: history,
            systemInstruction: { parts: [{ text: subagentSystemInstruction }] },
            tools: subagentTools
          };
        } else {
          const openAiMessages = createChatCompletionsMessages(history, subagentSystemInstruction);
          let openAiTools = [];
          if (subagentTools && subagentTools[0] && subagentTools[0].functionDeclarations) {
            for (let t of subagentTools[0].functionDeclarations) {
              openAiTools.push({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: convertSchemaTypesToLowercase(t.parameters) }
              });
            }
          }

          payload = {
            model: subagentModel || 'minimax-text-01',
            messages: openAiMessages,
            tools: openAiTools,
            tool_choice: 'auto'
          };

          if (subagentProvider === OPENAI_CODEX_PROVIDER) {
            endpointUrl = 'https://chatgpt.com/backend-api/codex/responses';
            payload = createCodexResponsesPayload(history, subagentSystemInstruction, subagentTools, targetModel || 'gpt-5.5', webSearchCheckpoint);
          } else if (subagentProvider === 'minimax') {
            if (!minimaxApiKey) throw new Error('MiniMax API key is missing. Add it in Settings before using MiniMax for subagents.');
            if (minimaxApiKey.startsWith('sk-cp-')) {
              endpointUrl = 'https://api.minimax.io/v1/chat/completions';
            } else {
              endpointUrl = 'https://api.minimax.chat/v1/chat/completions';
            }
            headers['Authorization'] = `Bearer ${minimaxApiKey}`;
            payload.model = subagentModel || 'minimax-m2.7';
          } else if (subagentProvider === 'moonshot') {
            if (!moonshotApiKey) throw new Error('Canopy Wave API key is missing. Add it in Settings before using Canopy Wave for subagents.');
            endpointUrl = 'https://inference.canopywave.io/v1/chat/completions';
            headers['Authorization'] = `Bearer ${moonshotApiKey}`;
            payload.model = subagentModel || 'moonshotai/kimi-k2.6';
          } else if (subagentProvider === 'ollama') {
            if (!ollamaApiKey) throw new Error('Ollama Cloud API key is missing. Add it in Settings before using Ollama for subagents.');
            endpointUrl = 'https://ollama.com/v1/chat/completions';
            headers['Authorization'] = `Bearer ${ollamaApiKey}`;
            payload.model = subagentModel || 'deepseek-v3.1:671b-cloud';
          } else if (subagentProvider === 'ollama_local') {
            if (!subagentModel) throw new Error('No local Ollama model selected. Open Settings and pick a model (Subagent Provider: Ollama (Local)).');
            // Use Ollama's native chat API so we can bound the context window (num_ctx) —
            // the OpenAI-compatible endpoint ignores it. The OpenAI-style messages/tools
            // payload is accepted natively; we just disable streaming and add options.
            endpointUrl = `${getOllamaLocalBase()}/api/chat`;
            payload.model = subagentModel;
            payload.stream = false;
            Object.assign(payload, getOllamaLocalRequestExtras());
          }
        }

        try {
          if (isGemini) {
            response = await fetchWithTimeout(endpointUrl, {
              method: 'POST',
              headers: headers,
              body: JSON.stringify(payload)
            }, SUBAGENT_MODEL_TIMEOUT_MS, subagentRecord);
          } else if (subagentProvider === OPENAI_CODEX_PROVIDER) {
            response = await fetchSubagentBackendModelRequest(subagentRecord, '/api/codex/responses', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ body: payload })
            }, SUBAGENT_MODEL_TIMEOUT_MS, 'codex_model');
          } else {
            // Route through local proxy to bypass CORS
            response = await fetchSubagentBackendModelRequest(subagentRecord, '/api/proxy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: endpointUrl,
                headers: headers,
                body: payload
              })
            }, SUBAGENT_MODEL_TIMEOUT_MS, 'model_proxy');
          }
        } catch (fetchErr) {
          if (isSubagentCancelled(subagentRecord)) throw fetchErr;
          if (isSubagentInterrupted(subagentRecord)) throw fetchErr;
          if (!isGemini && /failed to fetch|load failed|networkerror/i.test(fetchErr.message || '')) {
            const backendOk = await checkBackendHealth({ announce: true });
            if (!backendOk) {
              addSubagentMessage('Backend is unresponsive (likely blocked by another command). Retrying...');
              // We do not throw an error here. We let the retry loop handle it so the subagent doesn't die.
            }
          }
          retries++;
          if (retries > 15) {
            throw new Error(`Network/API request failed after ${retries} retries: ${fetchErr.message}`);
          }
          const backoff = retries * 2000 + Math.random() * 1000;
          addSubagentMessage(`Network error: ${fetchErr.message}. Retrying in ${(backoff / 1000).toFixed(1)}s... (Attempt ${retries}/15)`);
          await subagentSleep(backoff, subagentRecord);
          continue;
        }

        if (response.status === 429 || response.status >= 500) {
          if (isSubagentCancelled(subagentRecord)) throw new Error('Task cancelled by user.');
          retries++;
          const maxRetries = response.status >= 500 ? 5 : 8;
          if (retries > maxRetries) {
            throw new Error(`API returned status ${response.status} after ${retries} retries.`);
          }
          const backoff = Math.min(retries * 8000, 30000) + Math.random() * 3000;
          addSubagentMessage(`API Error (${response.status}). Retrying in ${(backoff / 1000).toFixed(1)}s... (Attempt ${retries}/${maxRetries})`);
          await subagentSleep(backoff, subagentRecord);
          continue;
        }
        break;
      }

      if (!response.ok) {
        const errorText = await readFetchResponseTextWithTimeout(response, SUBAGENT_MODEL_TIMEOUT_MS, subagentRecord);
        throw new Error(`API returned status ${response.status}: ${errorText}`);
      }

      let json;
      if (subagentProvider === OPENAI_CODEX_PROVIDER) {
        const sseText = await readFetchResponseTextWithTimeout(response, SUBAGENT_MODEL_TIMEOUT_MS, subagentRecord);
        json = parseCodexResponsesSseToGemini(sseText);
      } else {
        json = await readFetchResponseJsonWithTimeout(response, SUBAGENT_MODEL_TIMEOUT_MS, subagentRecord);
      }

      // Local Ollama's native /api/chat returns { message: {...} } instead of OpenAI's
      // choices[] — and tool-call arguments come back as an object, not a JSON string.
      // Normalize to the OpenAI shape so the translation below works unchanged.
      if (subagentProvider === 'ollama_local' && json && json.message && !json.choices) {
        const m = json.message;
        const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls.map((tc, i) => ({
          id: (tc && tc.id) || `call_${Date.now()}_${i}`,
          type: 'function',
          function: {
            name: tc && tc.function && tc.function.name,
            arguments: (tc && tc.function && typeof tc.function.arguments === 'string')
              ? tc.function.arguments
              : JSON.stringify((tc && tc.function && tc.function.arguments) || {})
          }
        })) : undefined;
        json = { choices: [{ message: { role: 'assistant', content: m.content || '', tool_calls: toolCalls } }] };
      }

      // Translate OpenAI response back to Gemini format
      if (subagentProvider !== 'gemini' && subagentProvider !== OPENAI_CODEX_PROVIDER) {
         let choice = json.choices && json.choices[0] && json.choices[0].message;
         if (choice) {
            let parts = [];
            if (choice.content) parts.push({ text: choice.content });
            if (choice.tool_calls) {
               for (let tc of choice.tool_calls) {
                  let args = {};
                  try { args = JSON.parse(tc.function.arguments); } catch(e){}
                  parts.push({ functionCall: { name: tc.function.name, args: args, id: tc.id } });
               }
            }
            json = { candidates: [{ content: { parts: parts } }] };
         }
      }
      const candidate = json.candidates && json.candidates[0];
      if (!candidate || !candidate.content) {
        throw new Error('No candidate content received from Gemini API.');
      }

      const modelContent = candidate.content;
      modelContent.role = 'model'; // Ensure role is explicitly set for parsing logic
      if (subagentProvider === OPENAI_CODEX_PROVIDER && Array.isArray(json.codexResponseItems)) {
        modelContent._codexResponseItems = json.codexResponseItems;
      }
      history.push(modelContent);

      const parts = modelContent.parts || [];
      const functionCalls = parts.filter(p => p.functionCall);

      if (functionCalls.length > 0) {
        codexPlainTextRepairCount = 0;
        const toolResponseParts = [];
        pendingToolCallsForInterruption = functionCalls;
        pendingToolResponsePartsForInterruption = toolResponseParts;
        let shouldStopAfterTools = false;
        let webSearchesThisTurn = 0;

        for (const part of functionCalls) {
          if (isSubagentCancelled(subagentRecord)) throw new Error('Task cancelled by user.');
          const call = part.functionCall;
          if (!call.id) {
            call.id = `call_${loopCount}_${toolResponseParts.length}_${Math.random().toString(36).slice(2, 8)}`;
          }
          console.log(`[Subagent] Step ${loopCount} Executing tool call:`, call.name, call.args);
          subagentRecord.lastMessage = `Executing tool: ${call.name}`;
          addSubagentMessage(`Executing tool: ${call.name}`);

          let responseData;
          let screenshotData = null;
          try {
            if (call.name === 'run_powershell_command') {
              // Block commands that could kill Shadow's runtime or wipe broad filesystem roots.
              subagentRecord.executedCommands.push(call.args.command || '');
              if (subagentRecord.executedCommands.length > 20) subagentRecord.executedCommands.shift();
              const dangerousPatterns = [
                /taskkill\s.*chrome/i,
                /taskkill\s.*node/i,
                /taskkill\s.*powershell/i,
                /stop-process\s.*chrome/i,
                /stop-process\s.*node/i,
                /stop-process\s.*powershell/i,
                /kill\s.*chrome/i,
                /remove-item\s+(-recurse\s+)?["']?[a-z]:\\/i,  // rm on drive root
                /format\s+[a-z]:/i,
                /rd\s+\/s/i
              ];
              const isBlocked = dangerousPatterns.some(p => p.test(call.args.command));
              if (isBlocked) {
                console.warn(`[Subagent] BLOCKED dangerous command: ${call.args.command}`);
                responseData = { output: 'BLOCKED: This command targets broad deletion, formatting, or Shadow runtime process termination. Use a narrower command that edits only the intended files.', status: 'error' };
                addSubagentMessage(`BLOCKED dangerous command.`);
              } else {
                const mediaValidation = validateMediaDownloadCommand(task, call.args.command, subagentRecord);
                if (!mediaValidation.ok) {
                  console.warn(`[Subagent] BLOCKED unsafe media download command: ${mediaValidation.error}`);
                  responseData = { output: mediaValidation.error, status: 'error' };
                  addSubagentMessage(`BLOCKED unsafe media download command: ${mediaValidation.error}`);
                } else {
                  const execCmd = mediaValidation.command || call.args.command;
                  if (shouldBlockCodexResearchPowerShellWebFetch(subagentRecord, execCmd, subagentProvider)) {
                    const prompt = getCodexResearchExhaustedPrompt({
                      count: Number(subagentRecord.webSearchCount) || 0,
                      hard_limit: getSubagentWebSearchHardLimit(subagentProvider, task) || Number(subagentRecord.webSearchCount) || 0
                    });
                    responseData = {
                      status: 'blocked',
                      output: 'BLOCKED: Codex research subagents must not use PowerShell web scraping after web_search evidence exists. Use gathered web_search results and finish, or finish partial with the exact evidence gap.',
                      next_action_required: prompt
                    };
                    if (!subagentRecord.steerQueue.includes(prompt)) subagentRecord.steerQueue.push(prompt);
                    addSubagentMessage('Blocked Codex PowerShell web fetch after web_search evidence.');
                  } else {
                  const researchRoutingReason = typeof getSmartConsultWorkRoutingReason === 'function'
                    ? getSmartConsultWorkRoutingReason(task)
                    : '';
                  const writesFile = /\b(set-content|add-content|out-file|new-item|copy-item)\b|(^|\s)>{1,2}/i.test(execCmd);
                  const requiresCurrentResearchFirst = isCurrentSourceSensitiveResearchTask(task)
                    || (researchRoutingReason && /source-backed research/i.test(researchRoutingReason));
                  if (requiresCurrentResearchFirst && writesFile && !subagentRecord.webSearchCount) {
                    responseData = {
                      output: 'BLOCKED: Current source-backed research requires web_search before writing files or reports. Search for current options first, then write only sourced links/results from tool output.',
                      status: 'error'
                    };
                    addSubagentMessage('Blocked source-backed file write before web research.');
                  } else {
                    if (mediaValidation.autoFixed) {
                      addSubagentMessage(`Auto-fixed yt-dlp command: added --match-title with title terms.`);
                    }
                    const commandTimeoutMs = getSubagentToolTimeoutForCommand(execCmd);
                    const cmdJson = await runNormalizedSubagentPowerShellCommand(subagentRecord, execCmd, commandTimeoutMs, 'tool');
                    responseData = {
                      output: cmdJson.output,
                      status: cmdJson.status,
                      exitCode: cmdJson.exitCode,
                      timedOut: Boolean(cmdJson.timedOut),
                      cancelled: Boolean(cmdJson.cancelled),
                      command_id: cmdJson.command_id,
                      assumed_success: Boolean(cmdJson.assumed_success),
                      assumed_success_reason: cmdJson.assumed_success_reason,
                      instruction: cmdJson.instruction
                    };

                    const summarySnippet = cmdJson.output.length > 150 ? cmdJson.output.substring(0, 150) + '...' : cmdJson.output;
                    addSubagentMessage(`PowerShell Output:\n${summarySnippet}`);
                  }
                  }
                }
              }
            } else if (call.name === 'web_search') {
              const query = (call.args.query || '').trim();
              const maxResults = Math.min(Math.max(Number(call.args.max_results) || 5, 1), 8);
              if (!query) {
                responseData = { status: 'error', error: 'Search query is required.' };
              } else {
                webSearchesThisTurn += 1;
                if (webSearchesThisTurn > 1) {
                  const prompt = getWebSearchBatchBlockedPrompt();
                  responseData = {
                    status: 'blocked',
                    query,
                    message: 'Only one web_search is allowed per assistant turn. This extra batched search was not executed.',
                    next_action_required: prompt
                  };
                  if (!subagentRecord.steerQueue.includes(prompt)) subagentRecord.steerQueue.push(prompt);
                  addSubagentMessage(`Web Search blocked: extra batched query "${query}"`);
                } else {
                  const searchCheckpoint = reserveSubagentWebSearch(subagentRecord, query, subagentProvider);
                  if (!searchCheckpoint.ok) {
                    const prompt = getWebSearchCheckpointGuidancePrompt(searchCheckpoint);
                    responseData = {
                      status: 'blocked',
                      query,
                      search_count: searchCheckpoint.count,
                      normal_search_checkpoint: searchCheckpoint.normal_checkpoint || searchCheckpoint.checkpoint,
                      message: searchCheckpoint.reason,
                      next_action_required: prompt
                    };
                    if (!subagentRecord.steerQueue.includes(prompt)) subagentRecord.steerQueue.push(prompt);
                    addSubagentMessage(`Web Search blocked: ${searchCheckpoint.reason}`);
                  } else {
                    let results = [];
                    let searchSource = '';
                    let searchError = '';
                    let searchHint = '';
                    try {
                      const proxyRes = await fetchWithTimeout('/api/search', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query, count: maxResults, timeout_ms: SUBAGENT_SEARCH_PROXY_TIMEOUT_MS })
                      }, SUBAGENT_SEARCH_TIMEOUT_MS, subagentRecord);
                      const proxyJson = await readFetchResponseJsonWithTimeout(proxyRes, SUBAGENT_SEARCH_TIMEOUT_MS, subagentRecord).catch(() => ({}));
                      if (!proxyRes.ok || proxyJson.status === 'error') {
                        searchHint = proxyJson.hint || '';
                        throw new Error(proxyJson.error || `Search proxy returned ${proxyRes.status}`);
                      }
                      results = Array.isArray(proxyJson.results) ? proxyJson.results.slice(0, maxResults).map(result => ({
                        title: result.title || '',
                        url: result.url || '',
                        content: (result.content || result.snippet || '').substring(0, 300)
                      })) : [];
                      searchSource = proxyJson.source || '/api/search';
                    } catch (proxyErr) {
                      results = [];
                      searchSource = 'failed_fast';
                      searchError = proxyErr && proxyErr.message ? proxyErr.message : String(proxyErr || 'Unknown search error.');
                    }
                    responseData = {
                      status: results.length > 0 ? 'success' : 'error',
                      query,
                      source: searchSource,
                      search_count: searchCheckpoint.count,
                      normal_search_checkpoint: searchCheckpoint.normal_checkpoint || searchCheckpoint.checkpoint,
                      hard_search_limit: searchCheckpoint.hard_limit || undefined,
                      searches_before_checkpoint: searchCheckpoint.searches_before_checkpoint,
                      searches_before_hard_limit: searchCheckpoint.searches_before_hard_limit,
                      past_normal_search_checkpoint: Boolean(searchCheckpoint.past_normal_checkpoint),
                      hard_search_limit_reached: Boolean(searchCheckpoint.hard_limit_reached),
                      search_guidance_note: searchCheckpoint.warning || undefined,
                      results: results.length > 0 ? results : undefined,
                      error: results.length === 0 ? `Web search failed${searchError ? `: ${searchError}` : ''}. Continue with another reliable route; do not repeat the same failing search.` : undefined,
                      search_error_detail: results.length === 0 ? (searchError || 'No results returned.') : undefined,
                      hint: results.length === 0 && searchHint ? searchHint : undefined
                    };
                    if (results.length > 0) {
                      subagentRecord.webSearchResultUrls = [
                        ...(subagentRecord.webSearchResultUrls || []),
                        ...results.map(result => result.url).filter(Boolean)
                      ].slice(-30);
                    }
                    if (searchCheckpoint.hard_limit_reached || searchCheckpoint.past_normal_checkpoint) {
                      const checkpointGuidance = {
                        ...searchCheckpoint,
                        reason: searchCheckpoint.hard_limit_reached
                          ? `Codex web_search hard limit reached (${searchCheckpoint.count}/${searchCheckpoint.hard_limit}).`
                          : `Web search evidence checkpoint reached (${searchCheckpoint.count}/${searchCheckpoint.checkpoint}).`
                      };
                      const prompt = getWebSearchCheckpointGuidancePrompt(checkpointGuidance);
                      responseData.search_checkpoint_reached = true;
                      responseData.next_action_guidance = prompt;
                      if (!subagentRecord.steerQueue.includes(prompt)) subagentRecord.steerQueue.push(prompt);
                    }
                    addSubagentMessage(`Web Search: "${query}" -> ${results.length} result(s)`);
                  }
                }
              }
            } else if (call.name === 'read_file') {
              const filePath = call.args.path || '.';
              const maxLines = call.args.max_lines || 500;
              try {
                const psCmd = `$p = Resolve-Path '${filePath.replace(/'/g, "''")}' -ErrorAction Stop; $c = Get-Content $p -TotalCount ${maxLines} -ErrorAction Stop; $c | ConvertTo-Json -Compress`;
                const json = await runSubagentPowerShellCommand(subagentRecord, psCmd, SUBAGENT_TOOL_TIMEOUT_MS, 'read_file');
                responseData = {
                  path: filePath,
                  content: json.output,
                  status: json.status,
                  exitCode: json.exitCode,
                  timedOut: Boolean(json.timedOut),
                  cancelled: Boolean(json.cancelled),
                  command_id: json.command_id
                };
                addSubagentMessage(`Read file: ${filePath}`);
              } catch (err) {
                responseData = { path: filePath, content: `Error reading file: ${err.message}`, status: 'error' };
              }
            } else if (call.name === 'list_directory') {
              const dirPath = call.args.path || '.';
              const pattern = call.args.pattern || '';
              try {
                let psCmd = `Get-ChildItem -Path '${dirPath.replace(/'/g, "''")}' -ErrorAction Stop`;
                if (pattern) psCmd += ` | Where-Object { $_.Name -like '${pattern.replace(/'/g, "''")}' }`;
                psCmd += ` | Select-Object Name, Length, LastWriteTime, PSIsContainer | ConvertTo-Json -Compress`;
                const json = await runSubagentPowerShellCommand(subagentRecord, psCmd, SUBAGENT_TOOL_TIMEOUT_MS, 'list_directory');
                responseData = {
                  path: dirPath,
                  entries: json.output,
                  status: json.status,
                  exitCode: json.exitCode,
                  timedOut: Boolean(json.timedOut),
                  cancelled: Boolean(json.cancelled),
                  command_id: json.command_id
                };
                addSubagentMessage(`Listed directory: ${dirPath}`);
              } catch (err) {
                responseData = { path: dirPath, entries: `Error listing directory: ${err.message}`, status: 'error' };
              }
            } else if (call.name === 'gmail_list_messages') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await gmailListMessages(call.args || {}, workspaceOptions) };
              addSubagentMessage('Gmail messages listed via Google Workspace integration.');
            } else if (call.name === 'gmail_get_message') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await gmailGetMessage(call.args || {}, workspaceOptions) };
              addSubagentMessage('Gmail message retrieved via Google Workspace integration.');
            } else if (call.name === 'gmail_create_draft') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await gmailCreateDraft(call.args || {}, workspaceOptions) };
              addSubagentMessage('Gmail draft created via Google Workspace integration.');
            } else if (call.name === 'gmail_send_message') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await gmailSendMessage(call.args || {}, workspaceOptions) };
              addSubagentMessage('Gmail message sent via Google Workspace integration.');
            } else if (call.name === 'google_calendar_list_events') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleCalendarListEvents(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Calendar events listed via Workspace integration.');
            } else if (call.name === 'google_calendar_create_event') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleCalendarCreateEvent(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Calendar event created via Workspace integration.');
            } else if (call.name === 'google_drive_list_files') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleDriveListFiles(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Drive files listed via Workspace integration.');
            } else if (call.name === 'google_drive_create_folder') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleDriveCreateFolder(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Drive folder created via Workspace integration.');
            } else if (call.name === 'google_drive_upload_local_file') {
              responseData = { status: 'success', output: await googleDriveUploadLocalFile(call.args || {}, { subagentRecord, label: 'drive_upload' }) };
              addSubagentMessage('Local file uploaded to Google Drive via Workspace integration.');
            } else if (call.name === 'google_drive_upload_file') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleDriveUploadFile(call.args || {}, workspaceOptions) };
              addSubagentMessage('Small file uploaded to Google Drive via Workspace integration.');
            } else if (call.name === 'google_drive_download_file') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleDriveDownloadFile(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Drive file downloaded via Workspace integration.');
            } else if (call.name === 'google_drive_delete_file') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleDriveDeleteFile(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Drive file deleted via Workspace integration.');
            } else if (call.name === 'google_drive_move_file') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleDriveMoveFile(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Drive file moved via Workspace integration.');
            } else if (call.name === 'google_drive_update_file') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleDriveUpdateFile(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Drive file updated via Workspace integration.');
            } else if (call.name === 'google_docs_create') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleDocsCreate(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Doc created via Workspace integration.');
            } else if (call.name === 'google_docs_get') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleDocsGet(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Doc retrieved via Workspace integration.');
            } else if (call.name === 'google_sheets_create') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleSheetsCreate(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Sheet created via Workspace integration.');
            } else if (call.name === 'google_sheets_get') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleSheetsGet(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Sheet retrieved via Workspace integration.');
            } else if (call.name === 'google_sheets_read_range') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleSheetsReadRange(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Sheet range read via Workspace integration.');
            } else if (call.name === 'google_sheets_update_range') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleSheetsUpdateRange(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Sheet range updated via Workspace integration.');
            } else if (call.name === 'youtube_search') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await youtubeSearch(call.args || {}, workspaceOptions) };
              addSubagentMessage('YouTube searched via Workspace integration.');
            } else if (call.name === 'youtube_list_playlists') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await youtubeListPlaylists(call.args || {}, workspaceOptions) };
              addSubagentMessage('YouTube playlists listed via Workspace integration.');
            } else if (call.name === 'google_photos_list_albums') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googlePhotosListAlbums(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Photos albums listed via Workspace integration.');
            } else if (call.name === 'google_photos_list_media') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googlePhotosListMedia(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Photos media listed via Workspace integration.');
            } else if (call.name === 'google_photos_create_album') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googlePhotosCreateAlbum(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Photos album created via Workspace integration.');
            } else if (call.name === 'google_contacts_list') {
              const workspaceOptions = { subagentRecord };
              responseData = { status: 'success', output: await googleContactsList(call.args || {}, workspaceOptions) };
              addSubagentMessage('Google Contacts listed via Workspace integration.');
            } else if (call.name === 'finish_task') {
              const finalStatus = String(call.args.status || '').toLowerCase();
              const summary = call.args.summary || '';
              const verification = call.args.verification || '';
              const remainingIssues = call.args.remaining_issues || '';
              const finalText = `${summary}\n\nVerification: ${verification}${remainingIssues ? `\n\nRemaining issues: ${remainingIssues}` : ''}`.trim();
              let shouldStopForFinish = true;
              if (finalStatus === 'success' && typeof getSubagentFinishReadiness === 'function') {
                const readiness = getSubagentFinishReadiness(task, finalStatus, verification, subagentRecord);
                if (!readiness.ok) {
                  responseData = {
                    status: 'error',
                    error: `FINISH_BLOCKED: ${readiness.reason}`,
                    next_action_required: 'Run a verification tool call that proves the requested outcome, then call finish_task again.'
                  };
                  shouldStopForFinish = false;
                  addSubagentMessage(`Finish blocked: ${readiness.reason}`);
                }
              }
              if (finalStatus === 'success' && shouldStopForFinish && isRepeatableLearningTask(task) && !hasReusableLearningArtifact(subagentRecord)) {
                try {
                  const learningResult = await ensureReusableLearningArtifact(task, subagentRecord, finalText);
                  responseData = { status: 'success', message: 'Auto-saved reusable learning artifact before finishing.', learning: learningResult };
                  addSubagentMessage('Auto-learning completed before finish.');
                } catch (learningErr) {
                  const learningMessage = `${getLearningRequirementMessage(task, subagentRecord)} Auto-save failed: ${learningErr.message}`;
                  responseData = { status: 'error', error: learningMessage };
                  shouldStopForFinish = false;
                  addSubagentMessage(`Finish blocked: ${learningMessage}`);
                }
              }
              if (finalStatus === 'success' && shouldStopForFinish) {
                completeSubagentRecord(subagentRecord, finalText);
                renderSubagentFinalBubble('Subagent Completed', task, finalText);
                notifyVoiceSession(task, finalText, subagentRecord.id);
                if (!responseData || responseData.status !== 'success') responseData = { status: 'success', message: 'Task marked complete.' };
              } else if (finalStatus === 'success') {
                // Auto-learning failed; keep the subagent running so it can recover.
              } else if (finalStatus === 'partial') {
                partialSubagentRecord(subagentRecord, finalText, remainingIssues || 'Task only partially completed.');
                renderSubagentFinalBubble('Subagent Partially Completed', task, finalText);
                notifyVoiceSessionOfPartial(task, remainingIssues || summary || 'Task only partially completed.', subagentRecord.id);
                responseData = { status: 'partial', message: 'Task marked partially complete.' };
              } else {
                failSubagentRecord(subagentRecord, remainingIssues || summary || 'Subagent reported failure.');
                renderSubagentFinalBubble('Subagent Failed', task, finalText || subagentRecord.lastError);
                notifyVoiceSessionOfFailure(task, subagentRecord.lastError, subagentRecord.id);
                responseData = { status: 'failed', message: 'Task marked failed.' };
              }
              shouldStopAfterTools = shouldStopForFinish;
              if (shouldStopForFinish) addSubagentMessage(`Final status: ${subagentRecord.status}`);
            } else if (call.name === 'request_user_auth_checkpoint') {
              responseData = {
                status: 'error',
                error: 'BLOCKED: Browser/login automation checkpoints are disabled. Use direct Workspace/API tools or finish partial if an interactive website login is required.'
              };
              addSubagentMessage('Blocked browser auth checkpoint; browser automation is disabled.');
            } else if (call.name === 'run_browser_action') {
              // SAFETY: Block the 'close' action Ã¢â‚¬â€ subagents must NEVER close the browser
              responseData = {
                status: 'error',
                error: 'BLOCKED: Browser automation is disabled. Use web_search through the configured SearXNG endpoint for research, direct Google/Gmail tools for Workspace, or finish partial if an interactive website is required.'
              };
              addSubagentMessage('Blocked browser automation; use SearXNG search or direct APIs.');
            } else if (call.name === 'run_desktop_action') {
              const { action, x, y, text } = call.args;
              const lowerTask = String(task || '').toLowerCase();
              const lowerText = String(text || '').toLowerCase();
              const browserish = /\b(website|webpage|browser|chrome|edge|firefox|youtube|google|tweakers|pricewatch|amazon|bol\.com|login|sign in|2fa|captcha|passkey|authenticator|upload)\b/.test(`${lowerTask} ${lowerText}`);
              if (browserish) {
                responseData = { status: 'error', error: 'Blocked desktop/browser control. Browser automation is disabled; use web_search/SearXNG, direct APIs, or finish partial if an interactive website is required.' };
                addSubagentMessage('Blocked desktop action for browser-like task.');
              } else {
                const safeAction = quotePowerShellSingleQuotedString(action || '');
                const safeText = quotePowerShellSingleQuotedString(text || '');
                const safeX = normalizeDesktopCoordinate(x);
                const safeY = normalizeDesktopCoordinate(y);
                const cmd = `powershell -ExecutionPolicy Bypass -File ${quotePowerShellSingleQuotedString('./desktop_controller.ps1')} -Action ${safeAction} -X ${safeX} -Y ${safeY} -Text ${safeText}`;
                try {
                  const cmdJson = await runSubagentPowerShellCommand(subagentRecord, cmd, SUBAGENT_TOOL_TIMEOUT_MS, 'desktop');
                  responseData = {
                    status: cmdJson.status,
                    output: cmdJson.output,
                    exitCode: cmdJson.exitCode,
                    timedOut: Boolean(cmdJson.timedOut),
                    cancelled: Boolean(cmdJson.cancelled),
                    command_id: cmdJson.command_id
                  };
                } catch (err) {
                  responseData = { status: 'error', error: err.message };
                }
                addSubagentMessage(`Desktop Action: ${action} -> ${responseData.status}`);
              }
            } else if (call.name === 'save_skill') {
              try {
                if (!subagentRecord.checkedSkills) {
                  responseData = { status: 'error', error: 'Before save_skill, call get_available_skills to compare existing reusable workflows. If a similar skill exists, merge into it instead of creating a duplicate.' };
                  addSubagentMessage('Skill save blocked: duplicate check required first.');
                } else {
                  const res = await fetchWithTimeout('/api/skills/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ skill_name: call.args.skill_name, instructions: call.args.instructions })
                  }, SUBAGENT_TOOL_TIMEOUT_MS, subagentRecord);
                  const json = await readFetchResponseJsonWithTimeout(res, SUBAGENT_TOOL_TIMEOUT_MS, subagentRecord);
                  responseData = json;
                  if (json.status === 'success') {
                    subagentRecord.savedSkill = true;
                  }
                  if (json.status === 'success' && json.merged_into) {
                    addSubagentMessage(`Skill merged into existing skill "${json.merged_into}"`);
                  } else if (json.status === 'success') {
                    addSubagentMessage(`Saved new skill: ${call.args.skill_name}`);
                  }
                }
              } catch (err) {
                responseData = { status: 'error', error: err.message };
                addSubagentMessage(`Skill save error: ${err.message}`);
              }
            } else if (call.name === 'get_available_skills') {
              try {
                const psCmd = `
                  $shadowRoot = if ($scriptDir) { $scriptDir } else { Get-Location }
                  $skillsDir = Join-Path $shadowRoot "skills"
                  if (-not (Test-Path $skillsDir)) { "[]"; return }
                  $dirs = Get-ChildItem -Path $skillsDir -Directory
                  $res = @()
                  foreach ($d in $dirs) {
                    $instPath = Join-Path $d.FullName "instructions.txt"
                    if (Test-Path $instPath) {
                      $content = Get-Content $instPath -Raw
                      if ($null -ne $content) {
                        $res += [PSCustomObject]@{ name = $d.Name; content = $content }
                      }
                    }
                  }
                  if ($res.Count -eq 0) { "[]" } else { $res | ConvertTo-Json -Compress }
                `;
                const cmdJson = await runSubagentPowerShellCommand(subagentRecord, psCmd, SUBAGENT_TOOL_TIMEOUT_MS, 'skills');
                let skills = [];
                if (cmdJson.output && cmdJson.output.trim() && cmdJson.output.trim() !== 'Command executed successfully with no output.') {
                  try { skills = JSON.parse(cmdJson.output.trim()); } catch (e) {}
                }
                if (!Array.isArray(skills)) { skills = [skills]; }
                responseData = { status: 'success', skills: skills };
                subagentRecord.checkedSkills = true;
              } catch (err) {
                responseData = { status: 'error', error: err.message };
              }
              addSubagentMessage(`Checked available skills.`);
            } else if (call.name === 'delete_skill') {
              try {
                const res = await fetchWithTimeout('/api/skills/delete', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ skill_name: call.args.skill_name })
                }, SUBAGENT_TOOL_TIMEOUT_MS, subagentRecord);
                responseData = await readFetchResponseJsonWithTimeout(res, SUBAGENT_TOOL_TIMEOUT_MS, subagentRecord);
                addSubagentMessage(`Deleted skill: ${call.args.skill_name} -> ${responseData.status}`);
              } catch (err) {
                responseData = { status: 'error', error: err.message };
              }
            } else if (call.name === 'upsert_memory_node') {
              responseData = await apiUpsertMemoryNode(call.args.id, call.args.label, call.args.type, call.args.description);
              addSubagentMessage(`Upserted memory fact: ${call.args.label}`);
            } else if (call.name === 'link_memory_nodes') {
              responseData = await apiLinkMemoryNodes(call.args.sourceId, call.args.targetId, call.args.relationshipType);
              addSubagentMessage(`Linked memory node: ${call.args.sourceId} to ${call.args.targetId}`);
            } else if (call.name === 'delete_memory_node') {
              responseData = await apiDeleteMemoryNode(call.args.id);
              addSubagentMessage(`Deleted memory node: ${call.args.id}`);
            } else {
              responseData = { error: 'Unknown tool name' };
              addSubagentMessage(`Unknown tool execution warning: ${call.name}`);
            }
          } catch (toolErr) {
            if (isSubagentInterrupted(subagentRecord)) throw toolErr;
            console.error(`[Subagent] Tool execution failed for ${call.name}:`, toolErr);
            responseData = { error: toolErr.message };
            addSubagentMessage(`Tool error: ${toolErr.message}`);
          }
          if (isSubagentInterrupted(subagentRecord)) {
            throw new Error('Tool call interrupted by user correction.');
          }
          if (isSubagentCancelled(subagentRecord)) {
            throw new Error('Task cancelled by user.');
          }
          const responseStatus = (responseData && (responseData.status || (responseData.error ? 'error' : ''))) || 'unknown';
          if (typeof recordSubagentToolEvent === 'function') {
            recordSubagentToolEvent(subagentRecord, call.name, responseStatus, responseData);
          }
          subagentRecord.lastToolName = call.name;
          subagentRecord.lastToolStatus = responseStatus;
          if (subagentRecord.status === 'running' || subagentRecord.status === 'waiting_auth') {
            subagentRecord.lastMessage = `Tool ${call.name} completed: ${responseStatus}`;
          }
          const toolFailed = typeof isSubagentToolFailureStatus === 'function'
            ? isSubagentToolFailureStatus(responseStatus, responseData)
            : (responseStatus === 'error' || Boolean(responseData && responseData.error));
          if (toolFailed) {
            subagentRecord.failedToolCount += 1;
            subagentRecord.lastError = (responseData && (responseData.error || responseData.output)) || 'Tool returned an error.';
          } else {
            subagentRecord.failedToolCount = 0;
            subagentRecord.lastError = '';
          }
          refreshSubagentProgressState(subagentRecord);
          updateDiagnosticsPanel();

          toolResponseParts.push({
            functionResponse: {
              name: call.name,
              id: call.id,
              response: screenshotData ? { status: 'success', message: 'Screenshot taken successfully.' } : responseData
            }
          });
          const callKey = getSubagentToolCallKey(call);
          if (callKey) answeredToolCallIdsForInterruption.add(callKey);

          if (screenshotData) {
            toolResponseParts.push({
              inlineData: {
                mimeType: 'image/jpeg',
                data: screenshotData
              }
            });
          }
        }

        history.push({
          role: 'user',
          parts: toolResponseParts
        });
        pendingToolCallsForInterruption = [];
        pendingToolResponsePartsForInterruption = null;
        if (shouldStopAfterTools) break;
      } else {
        const textResponse = parts.map(p => p.text).join('\n').trim();
        if (isOpenAiCodexSubagentProvider(subagentProvider)) {
          codexPlainTextRepairCount++;
          if (maybeFinalizeCodexPlainTextResponse(task, subagentRecord, textResponse, codexPlainTextRepairCount)) {
            break;
          }
        }
        addSubagentMessage('Subagent returned a plain text final answer. Requesting required finish_task call.');
        history.push({
          role: 'user',
          parts: [{ text: getPlainTextFinishRepairPrompt(subagentProvider, textResponse) }]
        });
      }
    } catch (err) {
      if (isSubagentInterrupted(subagentRecord)) {
        appendInterruptedSubagentToolResponses(
          history,
          pendingToolCallsForInterruption,
          answeredToolCallIdsForInterruption,
          pendingToolResponsePartsForInterruption || []
        );
        consumeSubagentInterrupt(subagentRecord);
        addSubagentMessage('Interrupted current step. Continuing with queued correction and preserved context.');
        continue;
      } else if (isSubagentCancelled(subagentRecord)) {
        subagentRecord.status = 'cancelled';
        subagentRecord.lastMessage = 'Cancelled by user.';
        subagentRecord.completedAt = subagentRecord.completedAt || new Date().toISOString();
        console.log('[Subagent] Cancelled by user.');
      } else {
        failSubagentRecord(subagentRecord, err.message);
        console.error('[Subagent] Execution error:', err);
        addSubagentMessage(`Execution failed: ${err.message}`);
        notifyVoiceSessionOfFailure(task, err.message, subagentRecord.id);
      }
      break;
    }
  }

  if (loopCount >= maxLoops && subagentRecord.status === 'running') {
    failSubagentRecord(subagentRecord, `Max execution loop limit reached (${maxLoops}).`);
    addSubagentMessage(`Execution hit maximum loop limit (${maxLoops}).`);
    notifyVoiceSessionOfFailure(task, `Max execution loop limit reached (${maxLoops}).`, subagentRecord.id);
  }
}
