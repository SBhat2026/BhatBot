'use strict';
// Agentic tool-use loop (full autonomy). Runs a bounded model↔tool loop in Anthropic
// message shape: model emits tool_use blocks → we execute them via toolExec → feed
// tool_result back → repeat until the model stops calling tools (or maxSteps). Both the
// Anthropic and Ollama callers normalize their output to Anthropic-shaped content, so this
// loop is provider-agnostic. This is what makes the Coding/Browser/etc agents actually
// DO things instead of just describing them. See ARCHITECTURE.md §3/§6.

// caller(messages, system, tools) -> { content:[{type:'text'|'tool_use', ...}], stop_reason }
// toolExec(name, input) -> result object (JSON-serializable)
async function runToolLoop({ caller, toolExec, system, tools, userContent, maxSteps = 8, onEvent }) {
  const messages = [{ role: 'user', content: userContent }];
  let lastText = '';
  let toolCalls = 0;
  for (let step = 0; step < maxSteps; step++) {
    const resp = await caller(messages, system, tools);
    const content = resp.content || [];
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) { lastText = text; if (onEvent) try { onEvent({ type: 'text', text }); } catch {} }
    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length || resp.stop_reason === 'end_turn') {
      return { text: lastText, steps: step, toolCalls };
    }
    messages.push({ role: 'assistant', content });
    const results = [];
    for (const tu of toolUses) {
      toolCalls++;
      if (onEvent) try { onEvent({ type: 'tool', name: tu.name, input: tu.input }); } catch {}
      let res;
      try { res = await toolExec(tu.name, tu.input || {}); }
      catch (e) { res = { success: false, error: String(e && e.message || e) }; }
      if (onEvent) try { onEvent({ type: 'tool_done', name: tu.name, result: res }); } catch {}
      // Vision results may carry an image — pass it back so the model can SEE it.
      let trContent;
      if (res && res._image) {
        const { _image, _imageMime, ...rest } = res;
        trContent = [
          { type: 'text', text: JSON.stringify(rest).slice(0, 8192) },
          { type: 'image', source: { type: 'base64', media_type: _imageMime || 'image/jpeg', data: _image } },
        ];
      } else {
        trContent = JSON.stringify(res).slice(0, 60 * 1024);
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: trContent, is_error: res && res.success === false });
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: lastText, steps: maxSteps, toolCalls, maxed: true };
}

module.exports = { runToolLoop };
