# todo

- [x] SKILLs
- [x] reorganize TOML
- [x] unit tests
- [x] add IRC channel and the framework for further channel expansion
    - [x] the Discord channel should be moved to a channels folder, in which the IRC channel will also be placed
- [x] fix search tool
- [x] vision support
- [x] windows fixes
    on Windows, we get this:
    3 tests failed:
    ✗ agent > runAgent returns assistant text [31.00ms]
    ✗ tools > list_files returns entries [63.00ms]
    ✗ workspace > listFiles includes files [47.00ms]
    but on Linux & Macos, all tests pass
- [x] less verbose tool messages
- [x] Deep Research
- [x] reactions
- [x] finish plugins
- [ ] add plugin tests
- [ ] Add actual documentation to docs/ and rewrite the plugin documentation file
- [x] Update installers to support installation in current directory or user-provided
- [ ] Reduce `any` type usage (tools.ts, agent.ts, plugins.ts)
- [x] Replace custom TOML parser with @std/toml or similar
- [ ] Add config validation at load time
- [ ] Fix unused error variables in catch blocks
- [ ] Review path handling across workspace operations
- [ ] Implement rate limiting for tool calls and API requests
- [ ] Add plugin worker isolation (currently marked as "not fully implemented")
- [ ] Complete IRC channel feature parity with Discord
- [ ] Add API response caching
- [ ] Make semantic search embedding model configurable
- [ ] Expand test coverage beyond unit tests
- [ ] Add API documentation for internal interfaces
- [ ] Resolve TypeScript as devDependency instead of peerDependency
