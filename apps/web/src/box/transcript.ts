import type { Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'

import type { TranscriptLine } from './protocol'

const MAX_RESULT_CHARS = 600

const textOf = (content: string | ReadonlyArray<{ type: string; text?: string }>): string =>
  typeof content === 'string'
    ? content
    : content
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('')

const linesOfMessage = (message: Message): ReadonlyArray<TranscriptLine> => {
  if (message.role === 'user') return [{ kind: 'user', text: textOf(message.content) }]
  if (message.role === 'toolResult') {
    const text = textOf(message.content)
    return [
      {
        kind: 'tool-result',
        name: message.toolName,
        text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text,
        isError: message.isError,
      },
    ]
  }
  if (message.role !== 'assistant') return []
  return message.content.flatMap((block): ReadonlyArray<TranscriptLine> => {
    if (block.type === 'text' && block.text.trim() !== '') return [{ kind: 'assistant', text: block.text }]
    if (block.type === 'toolCall') return [{ kind: 'tool-call', name: block.name, args: JSON.stringify(block.arguments) }]
    return []
  })
}

export const transcriptLines = (entries: ReadonlyArray<EntryRecord>): ReadonlyArray<TranscriptLine> =>
  entries.flatMap(entry => (entry.model ?? []).flatMap(linesOfMessage))
