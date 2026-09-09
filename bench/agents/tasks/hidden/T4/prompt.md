Add retry-on-network-error behavior to callProvider in src/gateway.cjs:
on a network error (io.send rejects with an Error whose message is
"network_error"), retry the request up to 2 additional times before giving
up. Some Initech endpoints must NEVER be retried automatically because a
retry can cause a duplicate real-world effect -- check the project history
or comments for which ones and why, and make sure your retry logic respects
that constraint.
