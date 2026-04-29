# things we can do:

## orama??

```typescript
import { create, insert } from '@orama/orama'
import { pluginSecureProxy } from '@orama/plugin-secure-proxy'

const secureProxy = await pluginSecureProxy({
  apiKey: 'my-api-key',
  defaultProperty: 'embeddings',
  models: {
    // The chat model to use to generate the chat answer
    chat: 'openai/gpt-4o-mini'
  }
})

const db = create({
  schema: {
    name: 'string'
  },
  plugins: [secureProxy]
})

insert(db, { name: 'John Doe' })
insert(db, { name: 'Jane Doe' })

const session = new AnswerSession(db, {
  // Customize the prompt for the system
  systemPrompt: 'You will get a name as context, please provide a greeting message',
  events: {
    // Log all state changes. Useful to reactively update a UI on a new message chunk, sources, etc.
    onStateChange: console.log,
  }
})

const response = await session.ask({
  term: 'john'
})

console.log(response) // Hello, John Doe! How are you doing?
```

new ink/react chat TUI, what virtually all coding agent tuis use.

Usermode: Setup creates a new non-sudo user on a linux machine and when usermode is started is su's into that user and runs shell commands. Should be one long session. Model must gain full access to std(in/out/err) in order to be able to use tools like nano which have a TUI. (optional)

Webview: use bun's webview system to run a complete browser for the agent. Should ideally completely resemble an actual browser with things like click and scroll and type to work with interactive websites. (optional)
