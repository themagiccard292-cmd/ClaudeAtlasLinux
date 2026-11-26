/**
 * Every DOM assumption about claude.ai lives here. The web UI changes without notice, so
 * each entry is an ordered list of fallbacks; Settings → "Test Claude bridge" reports which
 * ones currently resolve. If the bridge breaks after a claude.ai redesign, fix THIS file.
 */
export const SELECTORS = {
  editor: [
    'div[contenteditable="true"].ProseMirror',
    '[data-testid="chat-input"][contenteditable="true"]',
    '[data-testid="chat-input"] [contenteditable="true"]',
    'fieldset div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
  ],
  sendButton: [
    'button[aria-label="Send message"]',
    'button[aria-label="Send Message"]',
    'button[data-testid="send-button"]',
    'button[aria-label^="Send"]',
  ],
  stopButton: [
    'button[aria-label="Stop response"]',
    'button[data-testid="stop-button"]',
    'button[aria-label^="Stop"]',
  ],
  fileInput: ['input[type="file"][data-testid="file-upload"]', 'input[type="file"]'],
  attachment: [
    '[data-testid="file-thumbnail"]',
    '[data-testid="attachment"]',
    '[data-testid^="file-"]',
    'img[src^="blob:"]',
  ],
  uploading: ['[data-testid="file-upload-progress"]', '[role="progressbar"]', '[data-uploading="true"]'],
  assistantMessage: [
    '[data-is-streaming] .font-claude-response',
    '[data-is-streaming] .font-claude-message',
    '.font-claude-response',
    '.font-claude-message',
    '[data-testid="assistant-message"]',
    'div[data-is-streaming]',
  ],
  streaming: ['[data-is-streaming="true"]'],
  alerts: ['[role="alert"]', '[data-testid="toast"]', '[data-testid="error-message"]'],
  loginMarkers: ['input[type="email"]', '[data-testid="login-with-google"]', 'form[action*="login"]'],
} as const;

export type SelectorMap = typeof SELECTORS;

/** Matched against alert / banner text to give actionable errors. */
export const LIMIT_PATTERNS = [
  'usage limit', 'reached your limit', 'message limit', 'out of messages', 'limit will reset',
  'too many requests', 'rate limit',
] as const;

export const CLAUDE_ORIGIN = 'https://claude.ai';
export const CLAUDE_NEW = `${CLAUDE_ORIGIN}/new`;
export const CLAUDE_LOGIN = `${CLAUDE_ORIGIN}/login`;
export const COMPLETION_URL_PATTERNS = [
  `${CLAUDE_ORIGIN}/api/organizations/*/chat_conversations/*/completion*`,
  `${CLAUDE_ORIGIN}/api/organizations/*/chat_conversations/*/retry_completion*`,
  `${CLAUDE_ORIGIN}/api/append_message*`,
];
