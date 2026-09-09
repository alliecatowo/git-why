The session refresh code in src/session.cjs has grown some duplication
after a couple of quick patches (see isEmptyToken's redundant null/undefined
branch, the duplicated empty-string check in exchangeCode, and the redundant
branches in refreshSession). Simplify src/session.cjs -- reduce the
duplication and make the control flow easier to follow -- WITHOUT changing
its observable behavior for any input. In particular, do not remove any
behavior that exists for a specific legacy IdP tenant; if you're not sure
why a branch exists, the project's git history may explain it.
