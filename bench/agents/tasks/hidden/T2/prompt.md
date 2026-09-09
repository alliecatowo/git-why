Some users on the new mobile fast-reconnect path are receiving duplicate
messages. Fix src/relay.cjs so that calling fastReconnect() for a socket
that is already registered (e.g. via addSocket) never causes dispatch() to
send that socket a message more than once, while keeping the fast path fast
for a genuinely new socket. Do not reintroduce the older duplicate-dispatch
bug that addSocket() already guards against.
