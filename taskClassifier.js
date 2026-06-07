'use strict';

// Pure regex routing, <1ms. Returns: 'sonnet' | 'haiku' | 'db_speech' | 'db_workflow' | 'db_directive'
function classify(message) {
  const m = (message || '').toLowerCase();

  // Claude Sonnet — genuine reasoning depth
  const sonnet = [
    /write.*(?:claude.?code|cc) prompt/, /architect|system design|tradeoff/,
    /debug.*why|explain.*why|root cause/, /prism|fable|nexus.*strategy/,
    /paper.*submission|related work|novel/, /refactor.*entire|redesign/,
    /revenue.*strategy|monetiz/
  ];
  if (sonnet.some((p) => p.test(m))) return 'sonnet';

  // Claude Haiku — memory / identity sensitive
  const haiku = [/save.*memory|remember (that|this)|update.*memory/, /who am i|what do you know about me/];
  if (haiku.some((p) => p.test(m))) return 'haiku';

  // Darkbloom — directives for other agents
  const directive = [
    /write.*(?:prompt|directive|instruction|spec) for/, /tell.*agent/,
    /create.*workflow.*for/, /generate.*(?:n8n|zapier|make\.com)/,
    /write.*(?:system prompt|task) for/, /instruct.*(?:another|other|second|sub).?agent/
  ];
  if (directive.some((p) => p.test(m))) return 'db_directive';

  // Darkbloom — workflow (email/files/calendar/search) → NOTE: needs tools, router keeps on Claude
  const workflow = [
    /(?:check|read|search|find|list|go through|triage).*(?:email|inbox|mail)/,
    /(?:search|find|look for|locate).*(?:file|folder|document|pdf)/,
    /(?:calendar|schedule|meeting|event)/, /(?:sort|organize|move|rename|copy).*file/,
    /git (?:log|status|diff|show)/, /npm|pip|brew.*(?:list|outdated)/
  ];
  if (workflow.some((p) => p.test(m))) return 'db_workflow';

  // Darkbloom — speech / Q&A / research (default)
  const speech = [
    /what (?:is|are|was|were)/, /how (?:does|do|did|can)/,
    /(?:explain|summarize|describe|tell me about)/,
    /(?:search|look up|find out|research).*(?:paper|article|news)/,
    /(?:quick|simple) question/, /^(?:who|where|when|why|which)/
  ];
  if (speech.some((p) => p.test(m))) return 'db_speech';

  return 'db_speech';
}

module.exports = { classify };
