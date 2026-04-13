/**
 * Mock-replay fixtures (fusion step 1.2bis, claw-code lesson:
 * "harness of parity by mock-replay").
 *
 * Each scenario declares:
 *   - `expected` — the *normalized* outcome every provider must produce
 *     (assistant text, done flag, finishReason, embedding vectors);
 *   - per-provider *wire-format* response bodies the mocked HTTP layer
 *     returns when the provider makes its call.
 *
 * These fixtures are hand-authored from published API docs rather than
 * recorded from live calls, so the suite runs offline in CI. Add a recorded
 * scenario later by dropping a new folder and an entry here.
 */

export interface ChatFixture {
  name: string;
  kind: 'chat';
  userPrompt: string;
  expected: {
    /** Concatenated delta text. */
    text: string;
    finishReason: 'stop' | 'length' | 'tool_call' | 'error' | 'cancelled';
    /** Minimum number of streamed chunks carrying text (for streaming scenarios). */
    minChunks: number;
  };
  wire: {
    ollama: string; // NDJSON
    openai: string; // SSE
    anthropic: string; // SSE
  };
}

export interface EmbeddingFixture {
  name: string;
  kind: 'embedding';
  texts: string[];
  dimension: number;
  expected: {
    vectors: number[][];
  };
  wire: {
    // Ollama: one /api/embeddings call per text — array indexed by call.
    ollama: Array<{ embedding: number[] }>;
    // OpenAI-compat: one /embeddings call with data[].
    openai: { data: Array<{ embedding: number[]; index: number }> };
  };
}

// MARK: - chat-simple

const OLLAMA_CHAT_SIMPLE =
  [
    { message: { content: 'Hi' }, done: false },
    { message: { content: '!' }, done: false },
    {
      message: { content: '' },
      done: true,
      prompt_eval_count: 5,
      eval_count: 2,
    },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n') + '\n';

const OPENAI_CHAT_SIMPLE = [
  `data: ${JSON.stringify({
    choices: [{ delta: { content: 'Hi' } }],
  })}`,
  '',
  `data: ${JSON.stringify({
    choices: [{ delta: { content: '!' } }],
  })}`,
  '',
  `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  })}`,
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

const ANTHROPIC_CHAT_SIMPLE = [
  `event: message_start`,
  `data: ${JSON.stringify({
    type: 'message_start',
    message: { usage: { input_tokens: 5, output_tokens: 0 } },
  })}`,
  '',
  `event: content_block_delta`,
  `data: ${JSON.stringify({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'Hi' },
  })}`,
  '',
  `event: content_block_delta`,
  `data: ${JSON.stringify({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: '!' },
  })}`,
  '',
  `event: message_delta`,
  `data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 2 },
  })}`,
  '',
  '',
].join('\n');

export const chatSimple: ChatFixture = {
  name: 'chat-simple',
  kind: 'chat',
  userPrompt: 'Say hi.',
  expected: {
    text: 'Hi!',
    finishReason: 'stop',
    minChunks: 2,
  },
  wire: {
    ollama: OLLAMA_CHAT_SIMPLE,
    openai: OPENAI_CHAT_SIMPLE,
    anthropic: ANTHROPIC_CHAT_SIMPLE,
  },
};

// MARK: - chat-streaming

const tokens = ['1', ', ', '2', ', ', '3', '.'];

const OLLAMA_CHAT_STREAM =
  [
    ...tokens.map((t) => ({ message: { content: t }, done: false })),
    {
      message: { content: '' },
      done: true,
      prompt_eval_count: 7,
      eval_count: tokens.length,
    },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n') + '\n';

const OPENAI_CHAT_STREAM =
  tokens
    .map(
      (t) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`
    )
    .join('\n') +
  '\n' +
  `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 6, total_tokens: 13 },
  })}\n\ndata: [DONE]\n\n`;

const ANTHROPIC_CHAT_STREAM = [
  `event: message_start`,
  `data: ${JSON.stringify({
    type: 'message_start',
    message: { usage: { input_tokens: 7, output_tokens: 0 } },
  })}`,
  '',
  ...tokens.flatMap((t) => [
    `event: content_block_delta`,
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: t },
    })}`,
    '',
  ]),
  `event: message_delta`,
  `data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: tokens.length },
  })}`,
  '',
  '',
].join('\n');

export const chatStreaming: ChatFixture = {
  name: 'chat-streaming',
  kind: 'chat',
  userPrompt: 'Count 1 to 3.',
  expected: {
    text: '1, 2, 3.',
    finishReason: 'stop',
    minChunks: tokens.length,
  },
  wire: {
    ollama: OLLAMA_CHAT_STREAM,
    openai: OPENAI_CHAT_STREAM,
    anthropic: ANTHROPIC_CHAT_STREAM,
  },
};

// MARK: - embedding-pair

const V1 = [0.1, 0.2, 0.3, 0.4];
const V2 = [0.5, 0.4, 0.3, 0.2];

export const embeddingPair: EmbeddingFixture = {
  name: 'embedding-pair',
  kind: 'embedding',
  texts: ['hello', 'world'],
  dimension: 4,
  expected: { vectors: [V1, V2] },
  wire: {
    ollama: [{ embedding: V1 }, { embedding: V2 }],
    openai: {
      data: [
        { embedding: V1, index: 0 },
        { embedding: V2, index: 1 },
      ],
    },
  },
};

export const chatFixtures: ChatFixture[] = [chatSimple, chatStreaming];
export const embeddingFixtures: EmbeddingFixture[] = [embeddingPair];
